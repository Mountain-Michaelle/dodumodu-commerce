import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../../env";
import { createDb } from "../../db";
import * as blockRepo from "../../abuse/blockRepo";
import { PERMISSIONS, type Principal } from "../../auth/adminAuth";
import { requirePermissionOf, readBody, actorOf } from "./helpers";

// The Blocked screen's API.
//
// Every route requires an authorized operator and sits behind the Access gate
// applied once in admin.ts. A manual block is a human decision with a reason, so the
// reason is required here and validated again by the database CHECK.
//
// WHAT THIS ROUTER CANNOT DO, by construction: create a PHONE block. The schema
// constrains scope to 'ip' and 'device', so a permanent decision about a person is
// the spam flag's job and there is no endpoint here that reaches it.

export const blockRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

const createSchema = z.object({
  scope: z.enum(["ip", "device"]),
  value: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(12).max(500),
  // null means permanent. Only a human can choose that; the burst rules always
  // pass a number and the database CHECK refuses an automatic block with no expiry.
  seconds: z.number().int().positive().max(86400 * 7).nullable().default(600),
});

const releaseSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

/** Live blocks, newest first. Automatic ones are listed separately from manual. */
blockRoutes.get("/", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersRead);
  const db = createDb(c.env.DATABASE_URL);
  const [rows, counts] = await Promise.all([
    blockRepo.listActive(db),
    blockRepo.activeCounts(db),
  ]);
  return c.json({
    notice: "Live blocks only. An automatic block expires on its own after ten minutes.",
    counts,
    blocks: rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      value: r.scope === "ip" ? r.value : maskToken(r.value),
      source: r.source,
      automatic: r.source !== "manual",
      reason: r.reason,
      blockedBy: r.blockedBy,
      blockedAt: r.blockedAt,
      expiresAt: r.expiresAt,
      // Server-clock remaining, so the countdown an operator sees cannot disagree
      // with the countdown the customer is shown.
      remainingSeconds: r.expiresAt
        ? Math.max(0, Math.floor((new Date(r.expiresAt).getTime() - Date.now()) / 1000))
        : null,
      evidence: r.evidence,
    })),
  });
});

/** The full history, live or released. Why this is not a delete is the point. */
blockRoutes.get("/history", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersRead);
  const rows = await blockRepo.listAll(createDb(c.env.DATABASE_URL));
  return c.json({
    blocks: rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      value: r.scope === "ip" ? r.value : maskToken(r.value),
      source: r.source,
      reason: r.reason,
      blockedBy: r.blockedBy,
      blockedAt: r.blockedAt,
      expiresAt: r.expiresAt,
      releasedAt: r.releasedAt,
      releasedBy: r.releasedBy,
      releaseReason: r.releaseReason,
      evidence: r.evidence,
    })),
  });
});

blockRoutes.post("/", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersWrite);
  const body = await readBody(c, createSchema, "block");
  const db = createDb(c.env.DATABASE_URL);
  const row = await blockRepo.createBlock(db, {
    scope: body.scope,
    value: body.value,
    reason: body.reason,
    source: "manual",
    blockedBy: actorOf(c),
    seconds: body.seconds,
    evidence: null,
  });
  // null means another request created the identical block a moment earlier. That
  // is not an error to report as a failure - the intent is satisfied either way.
  return c.json({ block: row ? { id: row.id, scope: row.scope, expiresAt: row.expiresAt } : null, created: row !== null });
});

blockRoutes.post("/:id/release", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersWrite);
  const body = await readBody(c, releaseSchema, "release");
  const row = await blockRepo.releaseBlock(
    createDb(c.env.DATABASE_URL),
    Number(c.req.param("id")),
    actorOf(c),
    body.reason,
  );
  if (!row) {
    return c.json({ error: { message: "That block is no longer active." } }, 404);
  }
  return c.json({ block: { id: row.id, releasedAt: row.releasedAt, releasedBy: row.releasedBy } });
});

/**
 * Device tokens are opaque identifiers, not personal data, but there is no reason
 * to print one in full on a shared screen. Enough characters to tell two apart.
 */
function maskToken(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}