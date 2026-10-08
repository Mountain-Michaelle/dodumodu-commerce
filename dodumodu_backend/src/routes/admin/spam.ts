import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../../env";
import { createDb } from "../../db";
import { spamService } from "../../abuse/spamService";
import * as spamRepo from "../../abuse/spamRepo";
import { maskPhone } from "../../abuse/spamRepo";
import { abuseConfigFrom } from "../../abuse/config";
import { PERMISSIONS, type Principal } from "../../auth/adminAuth";
import { buildShadowReport } from "../../abuse/shadowReport";
import { requirePermissionOf, readBody, actorOf } from "./helpers";
import { normalizeSearch, likePattern } from "../../shared/listQuery";
// Admin moderation surface for spam flags.
//
// EVERY route here requires an authorized operator and is behind the Access gate
// applied once in admin.ts. There is no public route that reveals any of this.
//
// What is deliberately absent: nothing on this router can create a flag without a
// human supplying a reason, and nothing here can change an order's status, payment
// state or fulfilment state. Flagging is a statement about a phone number, not a
// transition in the order lifecycle.
// The principal Variable is declared so the shared helpers (requirePermissionOf,
// actorOf) accept this router exactly as they accept every other one. The value is
// set once by the authorization seam in admin.ts - never here, and never from a body.
export const spamRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();
// The reason is REQUIRED here as well as in the service. Validating at the edge
// gives the operator an immediate field error; the service check is the real
// guarantee, because the service is what anything else would have to go through.
const flagSchema = z.object({
  // A phone OR an order may be given. Phone is for a number seen elsewhere (a
  // suspect list, a WhatsApp message); order is the convenient path from the orders
  // screen. Exactly one is required, checked in the handler.
  phone: z.string().trim().max(40).optional(),
  orderId: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(500),
});
const revertSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
spamRoutes.get("/flagged", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersRead);
  const rows: Awaited<ReturnType<typeof spamRepo.listActive>> = await spamRepo.listActive(createDb(c.env.DATABASE_URL));
  // Masked by default. The full number belongs to the detail view of one record,
  // not to a list an operator scrolls past - and a table of full numbers is a
  // table of customer data.
  return c.json({
    flags: rows.map((row) => ({
      id: row.id,
      phoneMasked: maskPhone(row.phoneNorm),
      reason: row.reason,
      flaggedBy: row.flaggedBy,
      flaggedAt: row.flaggedAt,
      sourceOrderId: row.sourceOrderId,
    })),
  });
});
// SHADOW EVIDENCE. Read-only, and honest about what it is.
//
// This route exists so the owner can answer "would this policy interfere with
// genuine customers?" from measurements instead of intuition, BEFORE any
// enforcement is considered. It changes nothing: no flag, no order mutation, no
// threshold, and no behavioural difference between shadow and enforce other than
// the restriction itself.
//
// There is deliberately NO risk score here. A single number would hide the very
// thing that matters - a shared mobile carrier NAT and a fraudster can post
// identical request volumes and differ completely on legitimate progression, and
// only the second would ever approach a restriction.
spamRoutes.get("/shadow", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersRead);
  const config = abuseConfigFrom(c.env as unknown as Record<string, string | undefined>);
  // Optional, defaulting to the configured counting window, so this cannot be
  // used to inspect a period the counters were never keeping.
  const requested = Number(c.req.query("windowSeconds"));
  const windowSeconds = Number.isFinite(requested) && requested > 0 ? requested : config.windowSeconds;
  const report = await buildShadowReport(createDb(c.env.DATABASE_URL), { windowSeconds });
  return c.json({
    ...report,
    // Stated in the payload so a reader of the data cannot forget it.
    notice: "Shadow evidence only. Nothing here is a verdict, and nothing was blocked. "
      + "An IP is a shared address, not a person.",
  });
});
spamRoutes.get("/suspects", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersRead);
  const config = abuseConfigFrom(c.env as unknown as Record<string, string | undefined>);

  // --- optional query params: page, pageSize, q (search) ---
  const pageParam = c.req.query("page");
  const pageSizeParam = c.req.query("pageSize");
  const searchRaw = c.req.query("q");

  const parsedPage = pageParam === undefined ? 1 : Math.floor(Number(pageParam));
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
  const parsedSize = pageSizeParam === undefined ? 20 : Math.floor(Number(pageSizeParam));
  const pageSize = Number.isFinite(parsedSize) ? Math.max(1, Math.min(200, parsedSize)) : 20;
  const normalized = searchRaw ? normalizeSearch(searchRaw) : null;
  const phonePattern = normalized ? likePattern(normalized) : null;

  const total = await spamService.countSuspects(createDb(c.env.DATABASE_URL), {
    minOrders: config.softSuspectMinOrders,
    windowDays: config.softSuspectWindowDays,
    phonePattern,
  });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  const suspects = await spamService.listSuspects(createDb(c.env.DATABASE_URL), {
    minOrders: config.softSuspectMinOrders,
    windowDays: config.softSuspectWindowDays,
    limit: pageSize,
    offset: (safePage - 1) * pageSize,
    phonePattern,
  });

  return c.json({
    notice: "Suggestions only. Nothing here has been flagged; deciding is a human judgement.",
    suspects: suspects.map((s) => ({
      phoneMasked: maskPhone(s.phoneNorm),
      orders: s.orders,
      oldest: s.oldest,
      newest: s.newest,
    })),
    page: safePage,
    pageSize,
    total,
    totalPages,
    search: searchRaw ?? null,
  });
});
spamRoutes.post("/flag", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersWrite);
  const body = await readBody(c, flagSchema, "spam flag");
  const db = createDb(c.env.DATABASE_URL);
  const hasPhone = typeof body.phone === "string" && body.phone.length > 0;
  const hasOrder = typeof body.orderId === "number";
  if (hasPhone === hasOrder) {
    return c.json({
      error: { message: "Provide exactly one of phone or orderId." },
    }, 400);
  }
  const flag = hasOrder
    ? await spamService.flagFromOrder(db, {
      orderId: body.orderId as number, reason: body.reason, actor: actorOf(c),
    })
    : await spamService.flagPhone(db, {
      phone: body.phone as string, reason: body.reason, actor: actorOf(c),
    });
  return c.json({ flag: { id: flag.id, phoneMasked: maskPhone(flag.phoneNorm), flaggedAt: flag.flaggedAt } });
});
spamRoutes.post("/:id/revert", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersWrite);
  const body = await readBody(c, revertSchema, "spam revert");
  const row = await spamService.revert(createDb(c.env.DATABASE_URL), {
    id: Number(c.req.param("id")),
    reason: body.reason,
    actor: actorOf(c),
  });
  return c.json({ flag: { id: row.id, phoneMasked: maskPhone(row.phoneNorm), revertedAt: row.revertedAt } });
});
