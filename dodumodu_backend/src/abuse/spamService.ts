import type { Db } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../shared/httpError";
import { normalizePhone } from "../shared/normalizePhone";
import { ordersRepo } from "../data/ordersRepo";
import * as spamRepo from "./spamRepo";
import { dbErrorInfo } from "../shared/dbError";

// Manual spam flagging: the one hard, human decision in the abuse layer.
//
// WHAT THIS IS NOT, stated first because everything else follows from it:
//
//   - It is never automatic. Nothing in the observation layer can call flagPhone;
//     escalation from a temporary signal to a permanent record is exactly the
//     irreversible step this system refuses to take on a heuristic.
//   - It is not an order status. flagPhone touches no order row at all.
//   - It is not revocable by the customer, and it is not a judgement about
//     anyone who simply orders more than once.
//
// The reason is mandatory AND must be meaningful. "spam" is rejected: a flag with
// no explanation cannot be reviewed later, cannot be audited honestly, and trains
// the operator to click the button without thinking - which is how a real customer
// ends up permanently blocked over a misunderstanding.

/** Reasons that record nothing and are refused. */
const UNINFORMATIVE_REASONS = new Set(["spam", "spammer", "fraud", "fake", "scam", "test"]);

export const MIN_REASON_LENGTH = 12;

/**
 * Is this reason worth storing?
 *
 * Pure and exported so the rule is testable on its own: this is the only thing
 * standing between a one-click reflex and a permanent exclusion.
 */
export function validateReason(raw: string | null | undefined): string {
  const reason = (raw ?? "").trim().replace(/\s+/g, " ");
  if (reason.length === 0) {
    throw new ValidationError("A reason is required before a customer can be flagged.");
  }
  // The contentless check runs BEFORE the length check, and the order matters to
  // the person typing. "spam" is four characters, so a length-first check would
  // answer "add more characters" to someone who wrote the single most contentless
  // reason possible. The useful message is the one that says what is actually
  // wrong.
  if (UNINFORMATIVE_REASONS.has(reason.toLowerCase())) {
    throw new ValidationError(
      `"${reason}" does not explain anything. Describe what you observed, for example `
      + `"repeated fake orders using different phone numbers".`,
    );
  }
  if (reason.length < MIN_REASON_LENGTH) {
    throw new ValidationError(
      `Give a real reason (at least ${MIN_REASON_LENGTH} characters) so this can be reviewed later.`,
    );
  }
  return reason;
}

export const spamService = {
  /**
   * Flag a customer by phone number.
   *
   * The phone is normalized with the ONE shared normalizer, so a flag placed
   * against "+234 801 234 5678" also applies to a later order typed as
   * "08012345678". An unrecognized number is refused here - the operator can type
   * it differently - because a flag keyed on a guessed identity would exclude
   * nobody and block nobody, while looking like it had worked.
   */
  async flagPhone(
    db: Db,
    input: { phone: string; reason: string; actor: string; sourceOrderId?: number | null },
  ) {
    const phoneNorm = normalizePhone(input.phone);
    if (!phoneNorm) {
      throw new ValidationError(
        "That number could not be recognised. Check it and try again.",
      );
    }
    const reason = validateReason(input.reason);

    try {
      const row = await spamRepo.insert(db, {
        phoneNorm,
        sourceOrderId: input.sourceOrderId ?? null,
        reason,
        // From the Access identity, never the body.
        flaggedBy: input.actor,
      });
      console.log(JSON.stringify({
        event: "spam_flagged", phoneNorm, by: input.actor, sourceOrderId: input.sourceOrderId ?? null,
      }));
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("This customer already has an active spam flag", "reload");
      }
      throw error;
    }
  },

  /** Revert a flag. History is kept; only the ACTIVE state is cleared. */
  async revert(db: Db, input: { id: number; reason: string; actor: string }) {
    const reason = validateReason(input.reason);
    const row = await spamRepo.revert(db, input.id, input.actor, reason);
    if (!row) {
      throw new NotFoundError("Active spam flag", input.id);
    }
    console.log(JSON.stringify({ event: "spam_flag_reverted", id: input.id, by: input.actor }));
    return row;
  },

  /**
   * The check on the order path.
   *
   * Returns the flag, or null. A database failure here is the caller's problem to
   * handle, and the caller handles it by ALLOWING the order: order creation needs
   * the same database, so failing closed on a flag lookup could not protect
   * anything it was not already preventing.
   */
  async activeFlagFor(db: Db, phoneNorm: string | null) {
    if (!phoneNorm) return null;
    return spamRepo.findActive(db, phoneNorm);
  },

  /** Flag a customer based on an existing order. */
  async flagFromOrder(db: Db, input: { orderId: number; reason: string; actor: string }) {
    const order = await ordersRepo.findById(db, input.orderId);
    if (!order) throw new NotFoundError("Order", input.orderId);
    return this.flagPhone(db, {
      phone: order.phone,
      reason: input.reason,
      actor: input.actor,
      sourceOrderId: order.id,
    });
  },

  /** Suspects for the admin review list. Never flags anything by itself. */
  listSuspects(
    db: Db,
    opts: { minOrders: number; windowDays: number; limit?: number; offset?: number; phonePattern?: string | null },
  ) {
    return spamRepo.listSuspects(db, opts);
  },

  /** Count of active suspects matching an optional phone pattern. */
  async countSuspects(
    db: Db,
    opts: { minOrders: number; windowDays: number; phonePattern: string | null },
  ): Promise<number> {
    return spamRepo.countSuspects(db, { ...opts });
  },

  listActive(db: Db) {
    return spamRepo.listActive(db);
  },
};

/** Postgres unique-violation detection, same shape orderService uses. */
function isUniqueViolation(error: unknown): boolean {
  const { code, message } = dbErrorInfo(error);
  return code === "23505" || message.includes("duplicate key") || message.includes("unique");
}