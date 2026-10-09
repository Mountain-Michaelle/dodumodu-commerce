import { Hono } from "hono";
import type { Env } from "../../env";
import type { Db } from "../../db";
import { z } from "zod";
import { createDb } from "../../db";
import {
  ordersRepo, filtersFromQuery, ORDER_SORT_FIELDS, type OrderListItem,
} from "../../data/ordersRepo";
import { orderCrmService, availableActions } from "../../services/orderCrmService";
import { parseListQuery, pageMeta, normalizeSearch, likePattern } from "../../shared/listQuery";
import { orderListFiltersSchema } from "../../validation/adminSchema";
import { PERMISSIONS } from "../../auth/adminAuth";
import { orderCsv } from "./csv";
import { requirePermissionOf, readBody, actorOf } from "./helpers";
// Spam moderation reads only. Flagging and reverting are POSTs on /admin/spam
// behind their own permission checks; nothing on this router can create or clear
// a flag, and nothing here can change an order's status.
import * as spamRepo from "../../abuse/spamRepo";
import { maskPhone } from "../../abuse/spamRepo";
import { normalizePhone } from "../../shared/normalizePhone";
import * as orderEvidence from "../../abuse/orderEvidence";
import type { Principal } from "../../auth/adminAuth";

// Orders: the lightweight CRM surface. Delivery state is kept deliberately
// separate from payment state, and these routes are the only place that says
// which of the two an action touches.
//
// Every action is its own endpoint rather than a PATCH to /orders/:id/status with
// a "to" field, because the four actions have genuinely different rules: a
// delivery is guarded on the fulfilment state, a revert is guarded on being
// delivered AND derives where it goes from how the order was paid, and the two
// payment overrides require a different permission and record themselves as admin
// overrides. One endpoint would need a body saying which of those is happening,
// which is the same problem with an extra step.

const actionSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullish(),
  reason: z.string().trim().max(300).optional(),
});

// Cancellation is the one action that MUST say why. The schema validates and
// trims independently of the UI (a hand-made request is held to the same rule),
// and the service re-checks it, so no future caller can skip the reason by
// bypassing the panel. 12 characters is the same bar the block/release dialogs
// set: enough that the history entry explains itself months later.
const cancelSchema = actionSchema.extend({
  reason: z.string().trim().min(12).max(300),
});

const bulkSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1000),
  action: z.enum(["deliver", "revert", "mark-paid", "mark-failed", "cancel", "revert-cancel", "mark-not-picking"]),
});

const editSchema = z.object({
  // Strictly the fields an operator may correct on a delivery record. product,
  // quantity, prices, amount and payment references are absent by design: they
  // are not filtered out, they are not parameters this body can carry.
  customerName: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().regex(/^\+?[0-9]{10,14}$/, "Enter a valid phone number").optional(),
  whatsapp: z.string().trim().regex(/^\+?[0-9]{10,14}$/, "Enter a valid WhatsApp number").optional(),
  address: z.string().trim().min(5).max(500).optional(),
  state: z.string().trim().min(2).max(60).optional(),
  questionNotes: z.string().trim().max(500).nullish(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullish(),
});

const deleteSchema = z.object({ confirm: z.literal(true) });

function versionOf(body: { expectedUpdatedAt?: string | null }): Date | null {
  return body.expectedUpdatedAt ? new Date(body.expectedUpdatedAt) : null;
}

/**
 * The active spam flag for each order on this page, in ONE query.
 *
 * The list needs a yes/no per row for the subtle row tint. Asking per order would be
 * fifty queries to draw one screen, so this resolves the page's canonical identities
 * and asks once.
 *
 * Only a boolean and a masked number reach the browser here. The REASON belongs in
 * the order detail - a table of reasons is a wall of text an operator reads past on
 * every page to find the one row that matters.
 */
async function withSpamFlags(db: Db, orders: { id: number; phone: string }[]) {
  const withIdentity = orders.map((order) => ({
    id: order.id,
    phoneNorm: normalizePhone(order.phone),
  }));
  const identities = withIdentity.filter((o) => o.phoneNorm !== null).map((o) => o.phoneNorm as string);
  const flagged = await spamRepo.activePhoneSet(db, identities);
  return withIdentity.map((o) => ({ id: o.id, spamFlagged: o.phoneNorm !== null && flagged.has(o.phoneNorm) }));
}
/**
 * Whole-page enrichment: spam flags, reordering customers and duplicates.
 *
 * Three batched lookups, none of which loops per row. The DUPLICATE rule is now
 * owned entirely by orderEvidence - see the note where it is called - so this file
 * holds no second definition of it.
 */
export function orderRoutes() {
  const route = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

  route.get("/", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersRead);
    const query = parseListQuery(c.req.query(), {
      filters: orderListFiltersSchema,
      sortable: ORDER_SORT_FIELDS,
      defaultSort: "createdAt",
      defaultOrder: "desc",
    });
    if (!query) {
      return c.json({ error: { code: "INVALID_QUERY", message: "That filter combination is not valid" } }, 400);
    }

    const db = createDb(c.env.DATABASE_URL);
    const search = normalizeSearch(query.search);
    const { rows, total } = await ordersRepo.listForAdmin(db, {
      search: search ? likePattern(search) : null,
      filters: filtersFromQuery(query.filters),
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    });



    // Both enrichments are whole-page, fixed-cost queries. Neither adds a query
    // per displayed row.
    const spam = await withSpamFlags(db, rows);
    const spamById = new Map(spam.map((s) => [s.id, s.spamFlagged]));
    const evidence = await orderEvidence.evidenceForOrders(db, rows.map((row: any) => ({
      id: row.id,
      reference: row.reference,
      createdAt: row.createdAt,
      phoneNorm: row.phoneNorm ?? null,
      address: row.address ?? "",
      productId: row.productId,
      quantity: row.quantity,
    })));
    const orders = rows.map((o: OrderListItem) => {
      const item = evidence.get(o.id);
      return {
        ...o,
        actions: availableActions(o),
        // A boolean only. The reason lives on the detail screen, where there is room
        // to read it; the list carries only enough to tint the row.
        spamFlagged: spamById.get(o.id) === true,
        reordering: item?.reordering === true,
        // orderEvidence is the ONLY definition of the duplicate rule. The old
        // window-based check that used to be OR-ed in here compared the RAW phone
        // with no quantity, so it reported a different set of duplicates than the
        // badge now claims to describe. Two rules for one badge is how an operator
        // learns to distrust it.
        possibleDuplicate: item?.duplicateOf != null,
        duplicateOf: item?.duplicateOf
          ? { id: item.duplicateOf.id, reference: item.duplicateOf.reference }
          : null,
      };
    });

    return c.json({ orders, page: pageMeta(query, total) });
  });

  route.get("/csv", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersRead);
    const query = parseListQuery(c.req.query(), {
      filters: orderListFiltersSchema,
      sortable: ORDER_SORT_FIELDS,
      defaultSort: "createdAt",
      defaultOrder: "desc",
    });
    if (!query) {
      return c.json({ error: { code: "INVALID_QUERY", message: "That filter combination is not valid" } }, 400);
    }
    const db = createDb(c.env.DATABASE_URL);
    const search = normalizeSearch(query.search);
    // The current page, not everything: "copy this page" is the operation the
    // button offers, and exporting the whole table from a browser action is how a
    // list endpoint turns into an accidental full-table scan.
    const { rows } = await ordersRepo.listForAdmin(db, {
      search: search ? likePattern(search) : null,
      filters: filtersFromQuery(query.filters),
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    });
    // Built server-side so the escaping rule lives in exactly one place; the
    // browser's only job is to copy the exact characters it is handed.
    return c.json({ csv: orderCsv(rows) });
  });

  route.get("/:id", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersRead);
    const db = createDb(c.env.DATABASE_URL);
    const order = await ordersRepo.findById(db, Number(c.req.param("id")));
    if (!order) return c.json({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);

    // One order plus its history: two reads, both indexed by order_id, because a
    // detail screen that fetched the history per event would be exactly the N+1
    // this project is meant to avoid.
    const history = await ordersRepo.statusHistoryForOrder(db, order.id);
    // The full spam flag lives HERE and not on the list: this is where an operator
    // has room to read a reason and decide whether to revert it.
    //
    // Resolved from the canonical identity rather than the raw phone text, so it
    // matches however this particular order happened to be typed. A null identity
    // shows no flag - it never means "not flagged by accident".
    const phoneNorm = normalizePhone(order.phone);
    const spamFlag = phoneNorm ? await spamRepo.findActive(db, phoneNorm) : null;
    // Customer evidence and abuse observation. Both are strictly read-only: this
    // endpoint reports, it never decides anything about the order.
    const item = await orderEvidence.evidenceForOrder(db, {
      id: order.id,
      reference: order.reference,
      createdAt: order.createdAt,
      phoneNorm: phoneNorm,
      address: order.address,
      productId: order.productId,
      quantity: order.quantity,
    });
    const abuse = await orderEvidence.abuseObservationForIp(db, order.createdFromIp);
    return c.json({
      order: { ...order, actions: availableActions(order) },
      history,
      spamFlag: spamFlag && {
        id: spamFlag.id,
        phoneMasked: maskPhone(spamFlag.phoneNorm),
        reason: spamFlag.reason,
        flaggedBy: spamFlag.flaggedBy,
        flaggedAt: spamFlag.flaggedAt,
      },
      // `phoneKnown: false` is itself meaningful: it says the number could not be
      // canonically resolved and no identity claim was made about this customer.
      evidence: {
        phoneKnown: phoneNorm !== null,
        phoneMasked: phoneNorm ? maskPhone(phoneNorm) : null,
        reordering: item.reordering,
        previousOrders: item.previousOrders,
        previousSuccessful: item.previousSuccessful,
        lastOrderId: item.lastOrderId,
        lastOrderReference: item.lastOrderReference,
        lastOrderAt: item.lastOrderAt,
        duplicateOf: item.duplicateOf
          ? { id: item.duplicateOf.id, reference: item.duplicateOf.reference, createdAt: item.duplicateOf.createdAt }
          : null,
      },
      abuse: abuse && { ...abuse, ipMasked: orderEvidence.maskIp(order.createdFromIp) },
    });
  });

  route.patch("/:id", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersWrite);
    const body = await readBody(c, editSchema, "order edit");
    const { expectedUpdatedAt, ...patch } = body;
    const order = await orderCrmService.updateEditableFields(
      createDb(c.env.DATABASE_URL),
      Number(c.req.param("id")),
      patch,
      expectedUpdatedAt ? new Date(expectedUpdatedAt) : null,
    );
    return c.json({ order: { ...order, actions: availableActions(order) } });
  });

  route.post("/bulk-action", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersWrite);
    const body = await readBody(c, bulkSchema, "bulk action");
    // A bulk payment override is a payment override, so it needs the permission
    // a single one needs. Checking it here rather than per row is what stops
    // "select 200 and mark paid" from being a way around the single-row check.
    if (body.action === "mark-paid" || body.action === "mark-failed") {
      requirePermissionOf(c, PERMISSIONS.ordersPaymentOverride);
    }
    const result = await orderCrmService.bulkAction(
      createDb(c.env.DATABASE_URL), body.ids, body.action, actorOf(c),
    );
    return c.json(result);
  });

  route.post("/:id/deliver", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersWrite);
    const body = await readBody(c, actionSchema, "delivery");
    const order = await orderCrmService.deliver(
      createDb(c.env.DATABASE_URL), Number(c.req.param("id")), versionOf(body), actorOf(c), body.reason,
    );
    return c.json({ order: { ...order, actions: availableActions(order) } });
  });

  route.post("/:id/revert", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersWrite);
    const body = await readBody(c, actionSchema, "revert");
    const order = await orderCrmService.revert(
      createDb(c.env.DATABASE_URL), Number(c.req.param("id")), versionOf(body), actorOf(c), body.reason,
    );
    return c.json({ order: { ...order, actions: availableActions(order) } });
  });

  // The two payment overrides are separate endpoints and require their own
  // permission, so an operator with rights to move a delivery cannot quietly
  // acquire the right to assert that money arrived.
  route.post("/:id/mark-paid", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersPaymentOverride);
    const body = await readBody(c, actionSchema, "payment override");
    const order = await orderCrmService.manualPaymentOverride(
      createDb(c.env.DATABASE_URL), Number(c.req.param("id")), "paid", versionOf(body), actorOf(c), body.reason,
    );
    return c.json({ order: { ...order, actions: availableActions(order) } });
  });

  route.post("/:id/mark-failed", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersPaymentOverride);
    const body = await readBody(c, actionSchema, "payment override");
    const order = await orderCrmService.manualPaymentOverride(
      createDb(c.env.DATABASE_URL), Number(c.req.param("id")), "failed", versionOf(body), actorOf(c), body.reason,
    );
    return c.json({ order: { ...order, actions: availableActions(order) } });
  });

  route.post("/:id/cancel", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersWrite);
    const body = await readBody(c, cancelSchema, "cancellation");
    const order = await orderCrmService.cancel(
      createDb(c.env.DATABASE_URL), Number(c.req.param("id")), versionOf(body), actorOf(c), body.reason,
    );
    return c.json({ order: { ...order, actions: availableActions(order) } });
  });

  route.post("/:id/revert-cancel", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersWrite);
    const body = await readBody(c, actionSchema, "cancel reversion");
    const order = await orderCrmService.revertCancellation(
      createDb(c.env.DATABASE_URL), Number(c.req.param("id")), versionOf(body), actorOf(c), body.reason,
    );
    return c.json({ order: { ...order, actions: availableActions(order) } });
  });

  route.post("/:id/mark-not-picking", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersWrite);
    const body = await readBody(c, actionSchema, "not picking");
    const order = await orderCrmService.markNotPicking(
      createDb(c.env.DATABASE_URL), Number(c.req.param("id")), versionOf(body), actorOf(c), body.reason,
    );
    return c.json({ order: { ...order, actions: availableActions(order) } });
  });

  route.post("/:id/revert-not-picking", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersWrite);
    const body = await readBody(c, actionSchema, "not picking reversion");
    const order = await orderCrmService.revertNotPicking(
      createDb(c.env.DATABASE_URL),
      Number(c.req.param("id")),
      versionOf(body),
      actorOf(c),
      body.reason,
    );
    return c.json({ order: { ...order, actions: availableActions(order) } });
  });

  route.delete("/:id", async (c) => {
    requirePermissionOf(c, PERMISSIONS.ordersDelete);
    // `confirm: true` is required in the body, so a stray DELETE from a
    // mis-clicked link or a well-meaning script cannot remove an order.
    const body = await readBody(c, deleteSchema, "delete");
    await orderCrmService.remove(
      createDb(c.env.DATABASE_URL), Number(c.req.param("id")), body.confirm, actorOf(c),
    );
    return c.json({ deleted: true });
  });

  return route;
}
