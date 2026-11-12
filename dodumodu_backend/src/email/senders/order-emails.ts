import type { Env } from "../../env";
import type { Db } from "../../db";
import { orderBackupTemplate } from "../templates/order-backup";
import { orderFailureTemplate } from "../templates/order-failure";
import { q1 } from "../../auth/sql";
import { sql } from "../../auth/sql";
import { resendProvider, fromForEnv } from "../provider";
import { swallow } from "../../shared/logger";

export type OrderPayload = Record<string, unknown>;
export interface OrderMailMeta { ip: string | null; clientKind: string | null; }
export type MailResult = "sent" | "skipped" | "failed";

const ADMIN_LOOKUP_TIMEOUT_MS = 1500;
const ADMIN_CACHE_TTL_MS = 15 * 60_000;
const MAX_RECIPIENTS = 3;
let adminCache: { email: string; at: number } | null = null;
/** Test hook: forget the cached admin address. */
export function resetOrderMailCache(): void { adminCache = null; }

/** Run a send without delaying the response: waitUntil on the Worker, detached on Node. */
export function sendInBackground(c: unknown, p: Promise<unknown>): void {
  const tracked = p.catch(swallow("orderBackupMailer_best_effort_failed"));
  try {
    const ctx = (c as { executionCtx?: { waitUntil?: (x: Promise<unknown>) => void } }).executionCtx;
    if (ctx?.waitUntil) ctx.waitUntil(tracked);
  } catch {
    /* Node: executionCtx getter throws; the promise simply runs detached */
  }
}

const clean = (v: unknown, max = 500): string =>
  String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

function recipients(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    .slice(0, MAX_RECIPIENTS);
}

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
export async function sendOrderBackup(env: Env, order: OrderPayload, _meta: OrderMailMeta): Promise<MailResult> {
  try {
    const to = recipients((env as unknown as Record<string, string | undefined>).ORDER_BACKUP_EMAIL);
    const { subject, text, idempotencyKey } = orderBackupTemplate({
      customerName: order.customerName as string | undefined,
      quantity: order.quantity as string | undefined,
      productId: order.productId as string | undefined,
      state: order.state as string | undefined,
      idempotencyKey: order.idempotencyKey as string | undefined,
    });
    return await deliver(env, to, subject, text, idempotencyKey);
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
  return adminCache?.email ?? null;
}

/** (2) Failure alert for an order that was NOT saved. Goes to the database admin; if that
 * cannot be determined, to ORDER_BACKUP_EMAIL. Contains the full payload, so the order can
 * be keyed in by hand. Never throws. */
export async function sendOrderFailureAlert(
  env: Env, db: Db | null, order: OrderPayload, _meta: OrderMailMeta, reason: string, detail: string,
): Promise<MailResult> {
  try {
    const admin = await adminEmail(db);
    const fallback = recipients((env as unknown as Record<string, string | undefined>).ORDER_BACKUP_EMAIL);
    const to = [...new Set([...(admin ? [admin] : []), ...(admin ? [] : fallback)])];
    const { subject, text, idempotencyKey } = orderFailureTemplate({
      reason,
      detail,
      customerName: order.customerName as string | undefined,
      quantity: order.quantity as string | undefined,
      productId: order.productId as string | undefined,
      state: order.state as string | undefined,
      idempotencyKey: order.idempotencyKey as string | undefined,
    });
    return await deliver(env, to, subject, text, idempotencyKey);
  } catch (err) {
    console.error(JSON.stringify({ event: "order_mail_error", detail: err instanceof Error ? err.message : String(err) }));
    return "failed";
  }
}