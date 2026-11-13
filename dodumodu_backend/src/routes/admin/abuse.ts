// "Abuse & spam": the admin side of the two order-abuse rules (src/abuse/spamDiversion.ts).
//
//   GET  /abuse/summary             counts for the badge
//   GET  /abuse/held                held ("spam") orders - filter: status, q, from, to
//   POST /abuse/held/:id/release    put a wrongly held order back as a real order (idempotent)
//   POST /abuse/held/:id/dismiss    confirm it is spam (stays on file)
//   GET  /abuse/rpf                 rotating-phone-flood suspects - filter: status, scope, q
//   POST /abuse/rpf/:id/block       block the device and/or address of a suspect   (admin + authenticator step-up)
//   POST /abuse/rpf/:id/dismiss     not a flood
//
// Nothing here is reachable by a non-admin session (the route table is default-deny), and the one action that stops
// a person ordering - blocking - also goes through requireBlockAuthority. Blocking is always a click by a human.
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../../env";
import { createDb } from "../../db";
import { PERMISSIONS, type Principal } from "../../auth/adminAuth";
import { requireBlockAuthority } from "../../auth/blockGate";
import { requirePermissionOf, readBody, actorOf } from "./helpers";
import { NotFoundError, ConflictError, ValidationError } from "../../shared/httpError";
import * as repo from "../../abuse/holdRepo";
import * as blockRepo from "../../abuse/blockRepo";
import { orderService } from "../../services/orderService";
import { orderSchema } from "../../validation/orderSchema";

export const abuseRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal; authType?: string } }>();

const num = (v: string | undefined, fallback: number) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : fallback);
const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined => (allowed as readonly string[]).includes(v ?? "") ? (v as T) : undefined;
const idOf = (raw: string): number => {
  if (!/^\d+$/.test(raw)) throw new NotFoundError("record", raw);
  return Number(raw);
};
/** Device tokens are opaque, but there is no reason to print one in full; the full value only goes into a block. */
const maskToken = (v: string | null) => (v && v.length > 10 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);

abuseRoutes.get("/summary", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersRead);
  const db = createDb(c.env.DATABASE_URL);
  const [held, rpf] = await Promise.all([repo.countHeldOpen(db), repo.countOpenAlerts(db)]);
  return c.json({ heldOpen: held, rpfOpen: rpf });
});

abuseRoutes.get("/held", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersRead);
  const db = createDb(c.env.DATABASE_URL);
  const { rows, total } = await repo.listHeld(db, {
    status: oneOf(c.req.query("status"), ["held", "released", "dismissed", "all"] as const) ?? "held",
    q: c.req.query("q"), from: c.req.query("from"), to: c.req.query("to"),
    limit: num(c.req.query("limit"), 50), offset: num(c.req.query("offset"), 0),
  });
  return c.json({
    total,
    held: rows.map((r) => ({
      id: r.id, status: r.status, reference: r.reference, customerName: r.customer_name, phone: r.phone, address: r.address,
      reason: r.reason, ip: r.ip, device: maskToken(r.device_id), browser: r.browser, clientKind: r.client_kind,
      emailed: r.emailed, createdAt: r.created_at, resolvedBy: r.resolved_by, resolvedAt: r.resolved_at,
      releasedOrderId: r.released_order_id, items: r.payload,
    })),
  });
});

abuseRoutes.post("/held/:id/release", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersWrite);
  const db = createDb(c.env.DATABASE_URL);
  const id = idOf(c.req.param("id"));
  const held = await repo.getHeld(db, id);
  if (!held) throw new NotFoundError("held order", id);
  // Claim it first: a second click (or a second admin) finds nothing to claim and cannot create a second order.
  const claimed = await repo.resolveHeld(db, id, "released", actorOf(c), null);
  if (!claimed) throw new ConflictError("This held order was already handled.", "refresh-list");
  try {
    const parsed = orderSchema.safeParse({ ...held.payload, idempotencyKey: held.idempotency_key });
    if (!parsed.success) throw new ValidationError("The saved order is no longer valid", { order: ["Create it manually from the details shown."] });
    const { order } = await orderService.createOrder(db, c.env, parsed.data, { ip: held.ip, deviceId: held.device_id, clientKind: held.client_kind });
    await db.execute(repoSetOrder(id, order.id));
    return c.json({ released: true, orderId: order.id, reference: order.reference });
  } catch (err) {
    await repo.unresolveHeld(db, id).catch(() => undefined);     // nothing was created: it goes back on the list
    throw err;
  }
});

abuseRoutes.post("/held/:id/dismiss", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersWrite);
  const db = createDb(c.env.DATABASE_URL);
  const id = idOf(c.req.param("id"));
  const row = await repo.resolveHeld(db, id, "dismissed", actorOf(c), null);
  if (!row) throw new ConflictError("This held order was already handled.", "refresh-list");
  return c.json({ dismissed: true });
});

abuseRoutes.get("/rpf", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersRead);
  const db = createDb(c.env.DATABASE_URL);
  const { rows, total } = await repo.listAlerts(db, {
    status: oneOf(c.req.query("status"), ["open", "blocked", "dismissed", "all"] as const) ?? "open",
    scope: oneOf(c.req.query("scope"), ["ip", "device"] as const), q: c.req.query("q"),
    limit: num(c.req.query("limit"), 50), offset: num(c.req.query("offset"), 0),
  });
  return c.json({
    total,
    suspects: rows.map((r) => ({
      id: r.id, status: r.status, scope: r.subject_scope, ip: r.ip, device: maskToken(r.device_id), hasDevice: !!r.device_id,
      browser: r.browser, clientKind: r.client_kind, distinctPhones: r.distinct_phones, orderCount: r.order_count,
      orderIds: r.order_ids, windowMinutes: r.window_minutes, emailed: r.emailed, createdAt: r.created_at,
      resolvedBy: r.resolved_by, resolvedAt: r.resolved_at, note: r.resolution_note,
    })),
  });
});

const blockSchema = z.object({
  ip: z.boolean().optional(), device: z.boolean().optional(),
  reason: z.string().trim().min(3).max(300),
  seconds: z.number().int().positive().max(60 * 60 * 24 * 365).nullable().optional(),
});

abuseRoutes.post("/rpf/:id/block", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersWrite);
  await requireBlockAuthority(c);
  const body = await readBody(c, blockSchema, "block");
  const db = createDb(c.env.DATABASE_URL);
  const alert = await repo.getAlert(db, idOf(c.req.param("id")));
  if (!alert) throw new NotFoundError("alert", c.req.param("id"));
  if (alert.status !== "open") throw new ConflictError("This alert was already handled.", "refresh-list");
  const targets: Array<{ scope: "ip" | "device"; value: string }> = [];
  if (body.ip && alert.ip) targets.push({ scope: "ip", value: alert.ip });
  if (body.device && alert.device_id) targets.push({ scope: "device", value: alert.device_id });
  if (targets.length === 0) throw new ValidationError("Choose something to block", { ip: ["Pick the address and/or the device"] });
  for (const t of targets) {
    await blockRepo.createBlock(db, {
      scope: t.scope, value: t.value, reason: body.reason, source: "manual", blockedBy: actorOf(c),
      seconds: body.seconds ?? null, evidence: { alertId: alert.id, browser: alert.browser, phones: alert.distinct_phones },
    });
  }
  await repo.resolveAlert(db, alert.id, "blocked", actorOf(c), `blocked ${targets.map((t) => t.scope).join("+")}: ${body.reason}`);
  return c.json({ blocked: targets.map((t) => t.scope) });
});

abuseRoutes.post("/rpf/:id/dismiss", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersWrite);
  const db = createDb(c.env.DATABASE_URL);
  const row = await repo.resolveAlert(db, idOf(c.req.param("id")), "dismissed", actorOf(c), null);
  if (!row) throw new ConflictError("This alert was already handled.", "refresh-list");
  return c.json({ dismissed: true });
});

import { sql } from "../../auth/sql";
function repoSetOrder(heldId: number, orderId: number) {
  return sql`UPDATE held_orders SET released_order_id = ${orderId} WHERE id = ${heldId}`;
}
