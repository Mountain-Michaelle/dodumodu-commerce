import type { Env } from "../../env";
import type { Db } from "../../db";
import { q, sql } from "../../auth/sql";
import { emailList } from "../../abuse/spamConfig";
import type { AlertRow, HeldRow } from "../../abuse/holdRepo";
import type { MailResult } from "../../services/orderBackupMailer";
import { clean } from "../../services/orderBackupMailer";
import { resendProvider, fromForEnv } from "../provider";
import { heldOrderTemplate } from "../templates/held-order";
import { rpfAlertTemplate } from "../templates/rpf-alert";

// Notices for the two abuse rules. Same contract as the order mails: never throws into the order path, "skipped" when
// nothing is configured, one idempotency key per notice so a retry cannot send twice.
//   * held order  -> SPAM_ORDER_EMAIL
//   * RPF suspect -> RPF_ALERT_EMAIL, or every active admin's own address when that is not set

const rawEnv = (env: Env) => env as unknown as Record<string, string | undefined>;
const ADMIN_RECIPIENTS = 5;

/** True when held orders can actually be announced - the precondition for holding anything at all. */
export function canAnnounceHeld(env: Env): boolean {
  return emailList(rawEnv(env).SPAM_ORDER_EMAIL).length > 0 && (rawEnv(env).RESEND_API_KEY ?? "").trim().length > 0;
}

async function deliver(
  env: Env, to: string[], mail: { subject: string; text: string; html: string; idempotencyKey: string },
): Promise<MailResult> {
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  if (to.length === 0 || !apiKey) return "skipped";
  const provider = resendProvider(apiKey, fromForEnv(rawEnv(env)));
  const results = await Promise.all(to.map((addr, i) =>
    provider.send(addr, mail.subject, mail.text, `${mail.idempotencyKey}:${i}`, mail.html).catch(() => false)));
  const ok = results.some(Boolean);
  if (!ok) console.error(JSON.stringify({ event: "abuse_mail_failed", key: clean(mail.idempotencyKey, 80) }));
  return ok ? "sent" : "failed";
}

function failed(kind: "held" | "rpf", err: unknown): MailResult {
  console.error(JSON.stringify({ event: "abuse_mail_error", kind, detail: err instanceof Error ? err.message : String(err) }));
  return "failed";
}

export async function sendHeldOrderMail(env: Env, h: HeldRow): Promise<MailResult> {
  try {
    const fields = Object.entries(h.payload)
      .filter(([k, v]) => k !== "turnstileToken" && v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, clean(typeof v === "object" ? JSON.stringify(v) : v, 1000)] as const);
    return await deliver(env, emailList(rawEnv(env).SPAM_ORDER_EMAIL), heldOrderTemplate({
      id: h.id, customerName: h.customer_name, phone: h.phone, reason: h.reason, reference: h.reference, ip: h.ip,
      deviceId: h.device_id, browser: h.browser, clientKind: h.client_kind, receivedAt: h.created_at, fields,
    }));
  } catch (err) {
    return failed("held", err);
  }
}

async function adminAddresses(db: Db): Promise<string[]> {
  try {
    const rows = await q<{ email: string }>(db, sql`
      SELECT email FROM aa_users WHERE is_active AND role = 'admin' ORDER BY is_primary DESC, created_at LIMIT ${ADMIN_RECIPIENTS}`);
    return rows.map((r) => r.email);
  } catch { return []; }
}

export async function sendRpfAlertMail(env: Env, db: Db, a: AlertRow): Promise<MailResult> {
  try {
    const configured = emailList(rawEnv(env).RPF_ALERT_EMAIL);
    const to = configured.length > 0 ? configured : await adminAddresses(db);
    return await deliver(env, to, rpfAlertTemplate({
      id: a.id, scope: a.subject_scope, distinctPhones: a.distinct_phones, orderCount: a.order_count, windowMinutes: a.window_minutes,
      ip: a.ip, deviceId: a.device_id, browser: a.browser, clientKind: a.client_kind, orderIds: a.order_ids, raisedAt: a.created_at,
    }));
  } catch (err) {
    return failed("rpf", err);
  }
}
