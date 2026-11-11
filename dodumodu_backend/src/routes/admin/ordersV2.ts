// The v2 orders surface (spec §5.4). Mounted under ADMIN_BASE (/admin-v2), so
// it is flag-gated and origin-guarded by the auth router that hosts it, and it
// authenticates by SESSION COOKIE through guard() — never by the Cloudflare
// Access header the legacy /admin/* router relies on. That is the whole reason
// it is a separate router rather than more routes on the v1 orderRoutes(): the
// v1 router is typed for the Access principal and wrapped in Access middleware,
// and a v2 session request carries neither, so v2 routes can never live there.
//
// Authorization is the registry guard, the single source of truth. A status
// transition is privileged by its per-status key (permForAction -> the matching
// orders.status.<target>); the two targets the registry deliberately does NOT
// mint a grantable key for (cancelled, not_picking) are admin-only, so those
// fall through to requireAdmin. Admins implicitly hold every privilege.
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { createDb, type Db } from "../../db";
import type { AuthEnv } from "../../auth/middleware";
import { guard, requireAdmin } from "../../auth/middleware";
import {
  AuthUnauthorizedError, AuthForbiddenError, AuthRejectError,
  AuthLockedError, AuthServerFaultError, AuthRecoverableError,
} from "../../auth/errors";
import { ValidationError, errorShape } from "../../shared/httpError";
import { permForAction, registryGet } from "../../auth/registry";
import { orderScope } from "../../auth/orderScope";
import {
  ordersRepo, filtersFromQuery, ORDER_SORT_FIELDS, type OrderListItem,
} from "../../data/ordersRepo";
import {
  orderCrmService, availableActions, type OrderAction,
} from "../../services/orderCrmService";
import { parseListQuery, pageMeta, normalizeSearch, likePattern } from "../../shared/listQuery";
import { orderListFiltersSchema } from "../../validation/adminSchema";
import { orderSchema } from "../../validation/orderSchema";
import { orderCsv } from "./csv";
import { orderService, ProductNotFoundError, PackageNotFoundError, InvalidQuantityError, PaymentUnavailableError } from "../../services/orderService";
import { CodNotAvailableError } from "../../services/codPolicyService";
import { productsRepo } from "../../data/productsRepo";
import { knownStateNames, isKnownState, displayState } from "../../services/nigeriaStates";
import * as orderEvidence from "../../abuse/orderEvidence";
import * as spamRepo from "../../abuse/spamRepo";
import { normalizePhone } from "../../shared/normalizePhone";

type AppEnv = { Bindings: AuthEnv };

// The v2 body schema for a single transition. expectedUpdatedAt is the
// optimistic-concurrency token the panel was rendered from; reason is optional
// except for cancel, which the service re-checks so no caller can skip it.
const actionSchema = z.object({
  action: z.enum([
    "deliver", "revert", "mark-paid", "mark-failed",
    "cancel", "revert-cancel", "mark-not-picking", "revert-not-picking",
  ]),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullish(),
  reason: z.string().trim().max(300).optional(),
});

// Bulk: one action over a list of ids. assign/unassign are fulfilment routing
// (admin-only, flag-gated) and never touch status; the rest are status rules.
const bulkSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1000),
  action: z.enum([
    "deliver", "revert", "mark-paid", "mark-failed", "cancel", "revert-cancel",
    "mark-not-picking", "assign", "unassign",
  ]),
  assignTo: z.string().trim().toLowerCase().email().max(320).optional(),
});

const noteSchema = z.object({ note: z.string().trim().min(4).max(500) });

// Assignment Mode ships dark (see the v1 note): the toggle, the actions and the
// staff dropdown all refuse while this is off.
function assignmentEnabled(c: Context<AppEnv>): boolean {
  return c.env.ASSIGNMENT_MODE_ENABLED === "true";
}

/** Read + validate a JSON body, turning any failure into the shared 400. */
async function readJson<T extends z.ZodTypeAny>(
  c: Context<AppEnv>, schema: T, what = "request",
): Promise<z.infer<T>> {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    throw new ValidationError(`That ${what} was not valid JSON`, { body: ["Send a JSON object"] });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>;
    const populated: Record<string, string[]> = {};
    for (const [field, messages] of Object.entries(fields)) {
      if (messages && messages.length > 0) populated[field] = messages;
    }
    throw new ValidationError("Check the highlighted fields", populated);
  }
  return parsed.data;
}

/**
 * The one place a thrown error in this router becomes an HTTP response.
 *
 * It covers BOTH families the handlers can throw: the auth errors guard() and
 * requireAdmin raise (401/403, and 404 for an out-of-scope or missing order so
 * a caller never learns whether a record exists), and the shared CRM errors the
 * service raises (400/404/409 via errorShape). Anything else is answered as a
 * bare 500 with no internals — the same fail-closed contract the v1 admin
 * router keeps.
 */
function mapError(c: Context<AppEnv>, e: unknown): Response {
  if (e instanceof AuthLockedError) return c.json({ error: "Too many attempts" }, 429);
  if (e instanceof AuthServerFaultError) return c.json({ error: "Something went wrong", retry: true }, 503);
  if (e instanceof AuthForbiddenError) return c.json({ error: e.message }, 403);
  if (e instanceof AuthUnauthorizedError) return c.json({ error: e.message }, 401);
  if (e instanceof AuthRecoverableError) return c.json({ error: "Invalid code", recovery_available: true }, 401);
  // Out-of-scope / concealed: a 404, never a 403 that would confirm existence.
  if (e instanceof AuthRejectError) return c.json({ error: "Not found" }, 404);
  const shape = errorShape(e);
  if (shape) return c.json(shape.body, { status: shape.status });
  console.error(JSON.stringify({
    event: "admin_v2_unhandled_error",
    name: e instanceof Error ? e.name : "UnknownError",
    message: e instanceof Error ? e.message : String(e),
  }));
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side. Nothing was changed." } },
    500,
  );
}

async function guarded(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    return mapError(c, e);
  }
}

/**
 * Authorize one status transition. A target the registry mints a key for is
 * guarded by that key (so the privilege is exactly the per-status one); the two
 * reserved targets (cancelled, not_picking) have no grantable key and are
 * admin-only. Returns the session, whose email is the audit actor.
 */
async function authorizeTransition(c: Context<AppEnv>, action: OrderAction) {
  const perm = permForAction(action);
  if (registryGet(perm)) return guard({ perm })(c);
  return requireAdmin(c);
}

// The per-order transition, mapped to the matching CRM method. The methods all
// take (db, id, expectedUpdatedAt, actor, reason?) — one shared shape, so the
// dispatch below is a straight pass-through rather than a per-verb adaptation.
// mark-paid/mark-failed both route through manualPaymentOverride with the
// outcome as the distinguishing argument.
const ACTION_METHOD: Record<
  OrderAction,
  (db: Db, id: number, expectedUpdatedAt: Date | null, actor: string, reason?: string) => Promise<unknown>
> = {
  deliver: (db, id, v, actor, reason) => orderCrmService.deliver(db, id, v, actor, reason),
  revert: (db, id, v, actor, reason) => orderCrmService.revert(db, id, v, actor, reason),
  "mark-paid": (db, id, v, actor, reason) => orderCrmService.manualPaymentOverride(db, id, "paid", v, actor, reason),
  "mark-failed": (db, id, v, actor, reason) => orderCrmService.manualPaymentOverride(db, id, "failed", v, actor, reason),
  cancel: (db, id, v, actor, reason) => orderCrmService.cancel(db, id, v, actor, reason ?? ""),
  "revert-cancel": (db, id, v, actor, reason) => orderCrmService.revertCancellation(db, id, v, actor, reason),
  "mark-not-picking": (db, id, v, actor, reason) => orderCrmService.markNotPicking(db, id, v, actor, reason),
  "revert-not-picking": (db, id, v, actor, reason) => orderCrmService.revertNotPicking(db, id, v, actor, reason),
};

/** Spam flags for a page of orders, in one query (mirrors the v1 enrichment). */
async function withSpamFlags(db: Db, orders: { id: number; phone: string }[]) {
  const withIdentity = orders.map((order) => ({ id: order.id, phoneNorm: normalizePhone(order.phone) }));
  const identities = withIdentity.filter((o) => o.phoneNorm !== null).map((o) => o.phoneNorm as string);
  const flagged = await spamRepo.activePhoneSet(db, identities);
  return withIdentity.map((o) => ({ id: o.id, spamFlagged: o.phoneNorm !== null && flagged.has(o.phoneNorm) }));
}

function versionOf(body: { expectedUpdatedAt?: string | null }): Date | null {
  return body.expectedUpdatedAt ? new Date(body.expectedUpdatedAt) : null;
}

export const orderV2Routes = new Hono<AppEnv>();

// Manual order entry (admin console "+ New order"). Authorised by the orders.add privilege, so it is a
// per-user switch like every other section. Same rules as a storefront order: the server prices it, applies
// the pay-on-delivery policy and delivery-fee rules (orderService.createOrder); nothing is trusted from the
// form except the product, package, quantity and customer fields.
const manualOrderSchema = orderSchema.omit({ turnstileToken: true, idempotencyKey: true }).extend({
  // Sent by the form so a double-click cannot create two orders; generated here when absent.
  idempotencyKey: z.string().uuid().optional(),
  state: orderSchema.shape.state.refine(isKnownState, "Choose a state from the list"),
});

// GET /admin-v2/orders/form-options — what the "+ New order" modal needs, behind orders.add (not products.view,
// so an operator who may enter orders does not also get the product catalogue admin).
orderV2Routes.get("/form-options", async (c) => guarded(c, async () => {
  await guard({ perm: "orders.add" })(c);
  const all = await productsRepo.listAll(createDb(c.env.DATABASE_URL));
  return c.json({
    products: all.filter((p) => p.active).map((p) => ({
      id: p.id, name: p.name, price: p.price,
      packageOptions: Array.isArray(p.packageOptions) ? p.packageOptions : [],
    })),
    states: knownStateNames(),
    deliveryDates: [
      { value: "today", label: "Today" }, { value: "tomorrow", label: "Tomorrow" },
      { value: "next_tomorrow", label: "Day after tomorrow" },
    ],
    paymentMethods: [{ value: "cod", label: "Pay on delivery" }, { value: "pay_now", label: "Pay now (online)" }],
  });
}));

// POST /admin-v2/orders — create an order by hand. The order records who entered it (created_by). An operator
// restricted to their own orders is assigned the order they create, otherwise it would vanish from their list.
orderV2Routes.post("/", async (c) => guarded(c, async () => {
  const sess = await guard({ perm: "orders.add" })(c);
  const body = await readJson(c, manualOrderSchema, "order");
  const db = createDb(c.env.DATABASE_URL);
  try {
    const { order, checkoutUrl } = await orderService.createOrder(
      db, c.env as never,
      { ...body, idempotencyKey: body.idempotencyKey ?? crypto.randomUUID(), state: displayState(body.state), turnstileToken: "" },
      { createdBy: sess.email },
    );
    let assigned = order.assignedTo ?? null;
    if (orderScope(sess).restricted && assigned !== sess.email) {
      await orderCrmService.assign(db, [order.id], sess.email, sess.email, "created by assignee");
      assigned = (await ordersRepo.findById(db, order.id))?.assignedTo ?? null;
    }
    return c.json({ order: { ...order, assignedTo: assigned }, checkoutUrl, visibleToCreator: !orderScope(sess).restricted || assigned === sess.email }, 201);
  } catch (e) {
    if (e instanceof ProductNotFoundError) throw new ValidationError("Check the highlighted fields", { productId: ["Choose an active product"] });
    if (e instanceof PackageNotFoundError) throw new ValidationError("Check the highlighted fields", { packageId: ["Choose a package from the list"] });
    if (e instanceof InvalidQuantityError) throw new ValidationError("Check the highlighted fields", { quantity: [e.message] });
    if (e instanceof CodNotAvailableError) throw new ValidationError("Check the highlighted fields", { paymentMethod: [e.message] });
    if (e instanceof PaymentUnavailableError) throw new ValidationError("Check the highlighted fields", { paymentMethod: [e.message] });
    throw e;
  }
}));

// GET /admin-v2/orders — readout list. Same shape as the v1 list; the registry
// guard carries the authorization.
orderV2Routes.get("/", async (c) => guarded(c, async () => {
  const sess = await guard({ perm: "orders.view" })(c);
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
    // Row-level scope (Phase 6): a mono operator's list is only their own orders.
    scope: orderScope(sess).sqlWhere(),
  });
  const spam = await withSpamFlags(db, rows);
  const spamById = new Map(spam.map((s) => [s.id, s.spamFlagged]));
  const evidence = await orderEvidence.evidenceForOrders(db, rows.map((row: any) => ({
    id: row.id, reference: row.reference, createdAt: row.createdAt,
    phoneNorm: row.phoneNorm ?? null, address: row.address ?? "",
    productId: row.productId, quantity: row.quantity,
  })));
  const orders = rows.map((o: OrderListItem) => {
    const item = evidence.get(o.id);
    return {
      ...o,
      actions: availableActions(o),
      spamFlagged: spamById.get(o.id) === true,
      reordering: item?.reordering === true,
      possibleDuplicate: item?.duplicateOf != null,
      duplicateOf: item?.duplicateOf
        ? { id: item.duplicateOf.id, reference: item.duplicateOf.reference }
        : null,
    };
  });
  return c.json({ orders, page: pageMeta(query, total), assignmentEnabled: assignmentEnabled(c) });
}));

// GET /admin-v2/orders/export — the paper export (CSV). Registered before the
// :id routes so the static segment wins over a numeric id.
orderV2Routes.get("/export", async (c) => guarded(c, async () => {
  const sess = await guard({ perm: "orders.export" })(c);
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
  const { rows } = await ordersRepo.listForAdmin(db, {
    search: search ? likePattern(search) : null,
    filters: filtersFromQuery(query.filters),
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
    // Row-level scope (Phase 6): the export is only ever the operator's own rows.
    scope: orderScope(sess).sqlWhere(),
  });
  const csv = orderCsv(rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=orders-${new Date().toISOString().slice(0, 10)}.csv`,
    },
  });
}));


// POST /admin-v2/orders/bulk/action — one action over many ids. Registered
// before /:id so the static "bulk" segment is not read as an id.
orderV2Routes.post("/bulk/action", async (c) => guarded(c, async () => {
  const body = await readJson(c, bulkSchema, "bulk action");
  const db = createDb(c.env.DATABASE_URL);

  // Assignment is fulfilment routing: admin-only, flag-gated, and it never
  // touches status or payment, so it reuses orders.assign rather than a status
  // key.
  if (body.action === "assign" || body.action === "unassign") {
    const sess = await guard({ perm: "orders.assign" })(c);
    if (!assignmentEnabled(c)) {
      return c.json({ error: { code: "DISABLED", message: "Assignment Mode is not enabled" } }, 403);
    }
    if (body.action === "assign") {
      if (!body.assignTo) {
        return c.json({ error: { code: "INVALID_BODY", message: "assignTo (a staff email) is required to assign" } }, 400);
      }
      return c.json(await orderCrmService.assign(db, body.ids, body.assignTo, sess.email));
    }
    return c.json(await orderCrmService.unassign(db, body.ids, sess.email));
  }

  const sess = await authorizeTransition(c, body.action);
  // Row-level scope (Phase 6): a mono operator bulk-acts only on their own
  // orders; ids they do not own are concealed by bulkAction's scoped read.
  const result = await orderCrmService.bulkAction(
    db, body.ids, body.action, sess.email, orderScope(sess).sqlWhere(),
  );
  return c.json(result);
}));

// GET /admin-v2/orders/:id — readout. A missing order is concealed as a 404.
orderV2Routes.get("/:id", async (c) => guarded(c, async () => {
  const sess = await guard({ perm: "orders.view" })(c);
  const db = createDb(c.env.DATABASE_URL);
  const order = await ordersRepo.findById(db, Number(c.req.param("id")));
  if (!order) throw new AuthRejectError("order");
  // Row-level scope (Phase 6): conceal an out-of-scope order as the same 404 a
  // missing one gets, so a mono operator cannot probe for other people's orders.
  if (!orderScope(sess).allows(order.assignedTo)) throw new AuthRejectError("order");
  return c.json({ order });
}));

// GET /admin-v2/orders/:id/status — the single status property.
orderV2Routes.get("/:id/status", async (c) => guarded(c, async () => {
  const sess = await guard({ perm: "orders.view" })(c);
  const db = createDb(c.env.DATABASE_URL);
  const order = await ordersRepo.findById(db, Number(c.req.param("id")));
  if (!order) throw new AuthRejectError("order");
  if (!orderScope(sess).allows(order.assignedTo)) throw new AuthRejectError("order");
  return c.json({ status: order.status, updatedAt: order.updatedAt });
}));

// GET /admin-v2/orders/:id/annotations — the order's status history is the audit
// trail, gated by orders.audit.view. It answers "what does the history say"
// without a second table.
orderV2Routes.get("/:id/annotations", async (c) => guarded(c, async () => {
  const sess = await guard({ perm: "orders.audit.view" })(c);
  const db = createDb(c.env.DATABASE_URL);
  const order = await ordersRepo.findById(db, Number(c.req.param("id")));
  if (!order) throw new AuthRejectError("order");
  if (!orderScope(sess).allows(order.assignedTo)) throw new AuthRejectError("order");
  return c.json({ history: await ordersRepo.statusHistoryForOrder(db, order.id) });
}));

// POST /admin-v2/orders/:id/action — the v2 single-source transition surface.
orderV2Routes.post("/:id/action", async (c) => guarded(c, async () => {
  const body = await readJson(c, actionSchema, "action");
  const sess = await authorizeTransition(c, body.action);
  const db = createDb(c.env.DATABASE_URL);
  const id = Number(c.req.param("id"));
  const order = await ordersRepo.findById(db, id);
  if (!order) throw new AuthRejectError("order");
  // Row-level scope (Phase 6): the transition refuses an out-of-scope order the
  // same concealed way, so a mono operator cannot act on someone else's order.
  if (!orderScope(sess).allows(order.assignedTo)) throw new AuthRejectError("order");
  const method = ACTION_METHOD[body.action];
  const result = await method(db, order.id, versionOf(body), sess.email, body.reason);
  return c.json({ order: result });
}));

// POST /admin-v2/orders/:id/notes — append an audit note. Recorded as a
// status-history row with a null old-status (the same shape order creation
// uses), so the audit trail stays in one place; orders.change is the write
// authority, orders.audit.view the read authority — a view never lets a write.
orderV2Routes.post("/:id/notes", async (c) => guarded(c, async () => {
  const sess = await guard({ perm: "orders.change" })(c);
  const body = await readJson(c, noteSchema, "note");
  const db = createDb(c.env.DATABASE_URL);
  const id = Number(c.req.param("id"));
  const order = await ordersRepo.findById(db, id);
  if (!order) throw new AuthRejectError("order");
  if (!orderScope(sess).allows(order.assignedTo)) throw new AuthRejectError("order");
  await ordersRepo.writeStatusHistory(db, order.id, null, order.status, sess.email, body.note);
  return c.json({ note: { orderId: order.id, note: body.note } });
}));

