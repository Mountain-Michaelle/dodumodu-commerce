// Order safety net: every accepted order is emailed the moment it reaches the backend,
// in PARALLEL with the database write and never awaited by the customer's request.
//
//   1. BACKUP COPY  -> ORDER_BACKUP_EMAIL (env var/secret; comma-separated list allowed).
//      Sent for every verified order, concurrently with createOrder. Not configured, or
//      no RESEND_API_KEY -> skipped silently (never an error, never a delay).
//   2. FAILURE ALERT -> the admin email stored in the database, ONLY when the order could
//      not be saved (database rejected it or anything else broke). Built purely from the
//      request payload held in memory: it needs nothing from the orders table. The
//      admin address is read with a short timeout and cached, so when the database itself
//      is the thing that is down the last known address (or ORDER_BACKUP_EMAIL) is used.
//
// Both reuse the existing Resend provider (src/auth/email.ts) and its idempotency key, so a
// customer retry (same idempotency key) can never produce a second email.
// Nothing here can throw into the order path.
import type { Context } from "hono";
import type { Env } from "../env";
import type { Db } from "../db";
import { q1, sql } from "../auth/sql";
import { resendProvider, fromForEnv } from "../auth/email";
import { swallow } from "../shared/logger";

export type OrderPayload = Record<string, unknown>;
export interface OrderMailMeta { ip: string | null; clientKind: string | null; }
export type MailResult = "sent" | "skipped" | "failed";

const ADMIN_LOOKUP_TIMEOUT_MS = 1500;
const ADMIN_CACHE_TTL_MS = 15 * 60_000;
const MAX_RECIPIENTS = 3;
const SECRET_FIELDS = new Set(["turnstileToken"]);

let adminCache: { email: string; at: number } | null = null;
/** Test hook: forget the cached admin address. */
export function resetOrderMailCache(): void { adminCache = null; }

// In-flight sends, so tests (and a graceful shutdown) can wait for them.
const pending = new Set<Promise<unknown>>();
export async function flushOrderMail(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/** Run a send without delaying the response: waitUntil on the Worker, detached on Node. */
export function sendInBackground(c: Context, p: Promise<unknown>): void {
  const tracked = p.catch(swallow("orderBackupMailer_best_effort_failed")).finally(() => pending.delete(tracked));
  pending.add(tracked);
  try {
    const ctx = (c as Context & { executionCtx?: { waitUntil?: (x: Promise<unknown>) => void } }).executionCtx;
    if (ctx?.waitUntil) ctx.waitUntil(tracked);
  } catch {
    /* Node: executionCtx getter throws; the promise simply runs detached */
  }
}

/** Sanitize a value for inclusion in email text. */
export const clean = (v: unknown, max = 500): string =>
  String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

function recipients(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    .slice(0, MAX_RECIPIENTS);
}

function orderLines(order: OrderPayload, meta: OrderMailMeta): string {
  const lines = Object.entries(order)
    .filter(([k, v]) => !SECRET_FIELDS.has(k) && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${clean(typeof v === "object" ? JSON.stringify(v) : v, 1000)}`);
  lines.push(`receivedAt: ${new Date().toISOString()}`);
  lines.push(`ip: ${meta.ip ?? "unknown"}`);
  lines.push(`clientKind: ${meta.clientKind ?? "unknown"}`);
  return lines.join("\n");
}

const subjectOrder = (o: OrderPayload) =>
  `${clean(o.customerName, 60)} · ${clean(o.quantity, 6)}x product ${clean(o.productId, 12)} · ${clean(o.state, 30)}`;

async function deliver(
  env: Env, to: string[], subject: string, text: string, key: string,
): Promise<MailResult> {
  if (to.length === 0) return "skipped";
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) return "skipped";
  const provider = resendProvider(apiKey, fromForEnv(env as unknown as Record<string, string | undefined>));
  const results = await Promise.all(to.map((addr, i) =>
    provider.send(addr, subject, text, `${key}:${i}`).catch(() => false)));
  const ok = results.some(Boolean);
  if (!ok) console.error(JSON.stringify({ event: "order_mail_failed", key: clean(key, 80) }));
  return ok ? "sent" : "failed";
}

/** (1) Backup copy of a verified order. Never throws; "skipped" when not configured. */
export async function sendOrderBackup(env: Env, order: OrderPayload, meta: OrderMailMeta): Promise<MailResult> {
  try {
    const to = recipients((env as unknown as Record<string, string | undefined>).ORDER_BACKUP_EMAIL);
    return await deliver(env, to, `[ORDER] ${subjectOrder(order)}`,
      `A new order reached the backend. Saved independently of the database.\n\n${orderLines(order, meta)}\n`,
      `order-backup:${clean(order.idempotencyKey, 100)}`);
  } catch (err) {
    console.error(JSON.stringify({ event: "order_mail_error", detail: err instanceof Error ? err.message : String(err) }));
    return "failed";
  }
}

/** The admin address in the database (primary first), cached; null when unknowable. */
async function adminEmail(db: Db | null): Promise<string | null> {
  if (adminCache && Date.now() - adminCache.at < ADMIN_CACHE_TTL_MS) return adminCache.email;
  if (db) {
    try {
      const row = await Promise.race([
        q1<{ email: string }>(db, sql`
          SELECT email FROM aa_users WHERE is_active AND role = 'admin'
           ORDER BY is_primary DESC, created_at ASC LIMIT 1`),
        new Promise<null>((r) => setTimeout(() => r(null), ADMIN_LOOKUP_TIMEOUT_MS)),
      ]);
      if (row?.email) { adminCache = { email: row.email, at: Date.now() }; return row.email; }
    } catch { /* database is the problem: fall through to the stale cache */ }
  }
  return adminCache?.email ?? null;   // stale is better than nothing
}

/**
 * (2) Failure alert for an order that was NOT saved. Goes to the database admin; if that
 * cannot be determined, to ORDER_BACKUP_EMAIL. Contains the full payload, so the order can
 * be keyed in by hand. Never throws.
 */
export async function sendOrderFailureAlert(
  env: Env, db: Db | null, order: OrderPayload, meta: OrderMailMeta, reason: string, detail: string,
): Promise<MailResult> {
  try {
    const admin = await adminEmail(db);
    const fallback = recipients((env as unknown as Record<string, string | undefined>).ORDER_BACKUP_EMAIL);
    const to = [...new Set([...(admin ? [admin] : []), ...(admin ? [] : fallback)])];
    return await deliver(env, to, `[ORDER NOT SAVED] ${clean(reason, 40)} · ${subjectOrder(order)}`,
      `An order was received but could NOT be saved. Contact the customer or enter it manually.\n\n` +
      `reason: ${clean(reason, 80)}\nerror: ${clean(detail, 300)}\n\n${orderLines(order, meta)}\n`,
      `order-failed:${clean(order.idempotencyKey, 100)}:${clean(reason, 30)}`);
  } catch (err) {
    console.error(JSON.stringify({ event: "order_mail_error", detail: err instanceof Error ? err.message : String(err) }));
    return "failed";
  }
}
