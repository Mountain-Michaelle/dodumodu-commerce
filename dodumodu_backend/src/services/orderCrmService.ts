import type { Db } from "../db";
import { ordersRepo, type OrderRow } from "../data/ordersRepo";
import { normalizeState, displayState, isKnownState } from "./nigeriaStates";
import { ConflictError, NotFoundError, ValidationError } from "../shared/httpError";

// The CRM's own transition rules, kept separate from ordersRepo's LEGAL_TRANSITIONS
// on purpose. That map belongs to the PAYMENT lifecycle: awaiting_payment ->
// paid/failed is settled by the OPay webhook and by reconciliation, and nothing
// else is entitled to assert it. Folding "an admin pressed a button" into the same
// table would let a click mark a payment as settled, which is exactly the
// authority separation the payment design depends on. The two rule sets
// therefore never share a structure, and this file cannot quietly grant itself
// payment authority by editing a shared list.
//
// "Delivered" here means fulfilment, not payment: an operator confirming a
// parcel arrived is making a statement about the world, not about money.

// The statuses an order can be delivered FROM. Both are states in which the
// goods have been paid for (or are collectable) and are in a courier's hands.
const DELIVERABLE_FROM = new Set(["paid", "confirmed_cod"]);

// Where a delivery reverts TO, decided by how the order was paid rather than by
// anything the operator chose. A pay-now order that was delivered goes back to
// `paid`, because reverting the delivery does not un-charge the card. A COD order
// goes back to `confirmed_cod`, the state it was confirmed into. This is the rule
// that stops a revert from silently reclassifying collected money as
// outstanding.
const PRE_DELIVERY_STATUS: Record<string, string> = {
  pay_now: "paid",
  cod: "confirmed_cod",
};

export type OrderAction = "deliver" | "revert" | "mark-paid" | "mark-failed";

/**
 * The actions valid for one order, as the SERVER sees them. The panel renders
 * exactly this list rather than deciding for itself: an operator must never be
 * offered "mark delivered" on a failed order, and the only reliable place to
 * answer that is where the rules already are.
 */
export function availableActions(order: OrderRow): OrderAction[] {
  const actions: OrderAction[] = [];
  if (order.status === "delivered") {
    actions.push("revert");
  } else if (DELIVERABLE_FROM.has(order.status)) {
    actions.push("deliver");
  }

  // Payment overrides, offered only where they mean something. An override is for
  // a payment the gateway never confirmed, so "override" on an order already
  // paid or failed is a no-op that would only create a false history entry.
  if (order.status === "awaiting_payment") {
    actions.push("mark-paid", "mark-failed");
  }
  return actions;
}

export type BulkResult = {
  updated: { id: number; reference: string; action: OrderAction }[];
  skipped: { id: number; reference: string; reason: string }[];
  errors: { id: number; reason: string }[];
};

export const orderCrmService = {
  availableActions,

  /**
   * Mark delivered. delivered_at and status move in ONE statement (see
   * ordersRepo.markDelivered), guarded on the version the operator was shown.
   */
  async deliver(
    db: Db,
    id: number,
    expectedUpdatedAt: Date | null,
    actor: string,
    reason?: string,
  ): Promise<OrderRow> {
    const current = await ordersRepo.findById(db, id);
    if (!current) throw new NotFoundError("Order", id);

    if (current.status === "delivered") {
      throw new ConflictError("This order is already marked delivered", "reload", current);
    }
    if (!DELIVERABLE_FROM.has(current.status)) {
      // The server decides legality, never the browser. paid and confirmed_cod
      // are the only states in which goods are actually in transit to be
      // delivered; from awaiting_payment that claim would simply be false.
      throw new ValidationError(
        `An order can only be marked delivered from paid or confirmed COD - this one is ${current.status}.`,
        { status: ["Not deliverable from this state"] },
      );
    }

    const updated = await ordersRepo.markDelivered(db, id, current.status, expectedUpdatedAt);
    if (!updated) {
      // The WHERE matched nothing: somebody else changed the row between our read
      // and our write. That is a lost update, and silently retrying is how one
      // operator's "deliver" quietly undoes another's "revert".
      throw new ConflictError(
        "This order changed while you were looking at it. Reload and try again.",
        "reload",
        await ordersRepo.findById(db, id),
      );
    }

    await ordersRepo.writeStatusHistory(db, id, current.status, "delivered", actor, reason);
    console.log(JSON.stringify({ event: "order_delivered", id, reference: updated.reference, by: actor }));
    return updated;
  },

  /**
   * Undo a delivery. The status it returns to is derived from how the order was
   * paid, never from what the operator typed, so a revert can never turn a
   * collected payment into an outstanding one.
   */
  async revert(
    db: Db,
    id: number,
    expectedUpdatedAt: Date | null,
    actor: string,
    reason?: string,
  ): Promise<OrderRow> {
    const current = await ordersRepo.findById(db, id);
    if (!current) throw new NotFoundError("Order", id);

    if (current.status !== "delivered") {
      throw new ConflictError("This order is not marked delivered", "reload", current);
    }

    const toStatus = PRE_DELIVERY_STATUS[current.paymentMethod];
    const updated = await ordersRepo.revertDelivery(db, id, toStatus, expectedUpdatedAt);
    if (!updated) {
      throw new ConflictError(
        "This order changed while you were looking at it. Reload and try again.",
        "reload",
        await ordersRepo.findById(db, id),
      );
    }

    await ordersRepo.writeStatusHistory(db, id, "delivered", toStatus, actor, reason);
    console.log(JSON.stringify({
      event: "order_delivery_reverted", id, reference: updated.reference, toStatus, by: actor,
    }));
    return updated;
  },

  /**
   * A MANUAL payment override, deliberately not a CRM transition.
   *
   * This is the escape hatch for a payment the gateway never reported: cash
   * handed over at a counter, a transfer the operator can see in the bank app.
   * It is recorded as an admin override rather than as a webhook event, so the
   * audit trail never implies OPay confirmed something it did not.
   *
   * It does not weaken the normal path either. The webhook and reconciliation
   * keep their own rules, and this only ever moves an order still awaiting
   * payment - precisely the state in which no gateway has spoken yet.
   *
   * It is an assertion by a human that money changed hands. That is a real
   * override and is recorded as one, which is why it carries its own permission
   * rather than riding along with `orders:write`.
   */
  async manualPaymentOverride(
    db: Db,
    id: number,
    outcome: "paid" | "failed",
    expectedUpdatedAt: Date | null,
    actor: string,
    reason?: string,
  ): Promise<OrderRow> {
    const current = await ordersRepo.findById(db, id);
    if (!current) throw new NotFoundError("Order", id);

    if (current.paymentMethod !== "pay_now") {
      // A COD order has no payment to override: its "settled" state comes from
      // the customer's choice at checkout and is settled by delivery. Allowing an
      // override here would invent a payment the gateway was never asked for.
      throw new ValidationError(
        "Only a paid-up-front order can have its payment overridden - this one is pay on delivery.",
        { paymentMethod: ["Not a pay-now order"] },
      );
    }
    if (current.status !== "awaiting_payment") {
      throw new ConflictError(
        `This order is already ${current.status} - a payment override only applies to an order still awaiting payment.`,
        "reload",
        current,
      );
    }

    const updated = await ordersRepo.guardedStatusUpdate(
      db, id, "awaiting_payment", outcome, {}, expectedUpdatedAt,
    );
    if (!updated) {
      throw new ConflictError(
        "This order changed while you were looking at it. Reload and try again.",
        "reload",
        await ordersRepo.findById(db, id),
      );
    }

    // changedBy is "admin-override:<email>", never "webhook": the difference
    // between "the payment provider said so" and "an operator said so" is the
    // entire point of an audit trail.
    await ordersRepo.writeStatusHistory(
      db, id, "awaiting_payment", outcome, `admin-override:${actor}`, reason,
    );
    console.log(JSON.stringify({
      event: "order_payment_overridden", id, reference: updated.reference, outcome, by: actor,
    }));
    return updated;
  },

  /**
   * Edits to the delivery record. The allowlist is the TYPE, not a runtime
   * filter, so a field that is not on it cannot be edited even by a future caller
   * that tries: product, quantity, unit price, amount, payment status and
   * references are simply not parameters this function accepts.
   *
   * `state` is normalised on the way in for the same reason checkout order is -
   * two spellings of one state would fragment a later "orders in Enugu" query.
   */
  async updateEditableFields(
    db: Db,
    id: number,
    patch: Partial<Pick<OrderRow,
      "customerName" | "phone" | "whatsapp" | "address" | "state" | "questionNotes">>,
    expectedUpdatedAt: Date | null,
  ): Promise<OrderRow> {
    const current = await ordersRepo.findById(db, id);
    if (!current) throw new NotFoundError("Order", id);

    const normalized: typeof patch = { ...patch };
    if (normalized.state !== undefined) {
      // normalizeState is a comparison helper and lowercases; what is stored is
      // what a person is shown, so it is validated with one and written with the
      // other. isKnownState is the check that matters: normalizeState alone would
      // pass "Atlantis" straight through, and an order nobody can filter by state
      // is a customer who cannot be found for delivery.
      if (!isKnownState(normalized.state)) {
        throw new ValidationError("Enter a Nigerian state", { state: ["Not a known state"] });
      }
      // One stored spelling per place, so a later "orders in Enugu" filter matches
      // whether the operator typed "enugu" or "Enugu".
      normalized.state = displayState(normalizeState(normalized.state));
    }

    const updated = await ordersRepo.updateEditableFields(db, id, normalized, expectedUpdatedAt);
    if (!updated) {
      throw new ConflictError(
        "This order changed while you were looking at it. Reload and try again.",
        "reload",
        await ordersRepo.findById(db, id),
      );
    }
    return updated;
  },

  /**
   * A bulk action, in ONE request.
   *
   * The rows are read once and each is transitioned through the same rules a
   * single-row action would use, so "deliver 200 orders" cannot behave differently
   * from "deliver one order".
   *
   * Each row is a separate statement on purpose. The Neon HTTP driver has no
   * multi-statement transaction, and faking one would promise atomicity that does
   * not exist. What that costs is stated rather than hidden: a failure part-way
   * through leaves the earlier rows applied. The result object reports exactly
   * which ones, so the operator sees the truth instead of a single success flag
   * that hides a partial run.
   */
  async bulkAction(
    db: Db,
    ids: number[],
    action: OrderAction,
    actor: string,
  ): Promise<BulkResult> {
    const result: BulkResult = { updated: [], skipped: [], errors: [] };
    if (ids.length === 0) return result;

    // Read the rows rather than trusting the ids the browser sent: a page rendered
    // two minutes ago is not a statement about the database now, and every
    // transition below is checked against what is actually there.
    const rows = await ordersRepo.findByIds(db, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const id of ids) {
      const current = byId.get(id);
      if (!current) {
        result.errors.push({ id, reason: "No such order" });
        continue;
      }
      try {
        // No expectedUpdatedAt: a bulk action has no per-row version to check
        // against, because the operator never saw these rows individually. The
        // status guard is still applied, so an ineligible row is skipped rather
        // than forced.
        if (action === "deliver") {
          if (!DELIVERABLE_FROM.has(current.status)) {
            result.skipped.push({ id, reference: current.reference, reason: `Cannot deliver from ${current.status}` });
            continue;
          }
          const updated = await ordersRepo.markDelivered(db, id, current.status, null);
          if (!updated) {
            result.skipped.push({ id, reference: current.reference, reason: "Changed while running" });
            continue;
          }
          await ordersRepo.writeStatusHistory(db, id, current.status, "delivered", actor, "bulk action");
          result.updated.push({ id, reference: updated.reference, action });
        } else if (action === "revert") {
          if (current.status !== "delivered") {
            result.skipped.push({ id, reference: current.reference, reason: "Not marked delivered" });
            continue;
          }
          const toStatus = PRE_DELIVERY_STATUS[current.paymentMethod];
          const updated = await ordersRepo.revertDelivery(db, id, toStatus, null);
          if (!updated) {
            result.skipped.push({ id, reference: current.reference, reason: "Changed while running" });
            continue;
          }
          await ordersRepo.writeStatusHistory(db, id, "delivered", toStatus, actor, "bulk action");
          result.updated.push({ id, reference: updated.reference, action });
        } else {
          const outcome = action === "mark-paid" ? "paid" : "failed";
          if (current.paymentMethod !== "pay_now" || current.status !== "awaiting_payment") {
            result.skipped.push({ id, reference: current.reference, reason: "Not an unpaid pay-now order" });
            continue;
          }
          const updated = await ordersRepo.guardedStatusUpdate(db, id, "awaiting_payment", outcome, {}, null);
          if (!updated) {
            result.skipped.push({ id, reference: current.reference, reason: "Changed while running" });
            continue;
          }
          await ordersRepo.writeStatusHistory(
            db, id, "awaiting_payment", outcome, `admin-override:${actor}`, "bulk action",
          );
          result.updated.push({ id, reference: updated.reference, action });
        }
      } catch (err) {
        // One row failing must not abandon the rest: an operator clearing 200
        // orders does not want to be told "it broke" on number 37 with no idea
        // what happened to 1-36.
        result.errors.push({ id, reason: err instanceof Error ? err.message : "Unexpected error" });
      }
    }

    console.log(JSON.stringify({
      event: "order_bulk_action", action, by: actor,
      updated: result.updated.length, skipped: result.skipped.length, errors: result.errors.length,
    }));
    return result;
  },

  /**
   * Deleting an order. Requires explicit confirmation, enforced HERE rather than
   * in the route so no future caller can skip it, and refused outright for
   * anything paid or delivered: a completed sale is the record that the parcel
   * arrived, and removing it destroys the only evidence it did.
   */
  async remove(db: Db, id: number, confirm: boolean, actor: string): Promise<void> {
    const current = await ordersRepo.findById(db, id);
    if (!current) throw new NotFoundError("Order", id);

    if (!confirm) {
      throw new ValidationError("Deleting an order needs an explicit confirmation");
    }
    if (current.status === "delivered" || current.status === "paid") {
      throw new ConflictError(
        "A delivered or paid order cannot be deleted - it is the record of a completed sale. Revert the delivery first if it was marked in error.",
        "none",
      );
    }

    await ordersRepo.deleteById(db, id);
    console.log(JSON.stringify({ event: "order_deleted", id, reference: current.reference, by: actor }));
  },
};
