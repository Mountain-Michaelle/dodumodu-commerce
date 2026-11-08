// Security notifications for the admin bell: successful sign-ins (new vs known device),
// rate-limited sign-in attempts against a REAL account, and newly created users.
//
// Rules this module enforces:
//   * Never throws: every function swallows its own failure, so the sign-in,
//     the 429 or the user creation it observes can never be changed by it.
//   * Never reveals whether an email exists to the person typing it: a rate-limit
//     event is recorded ONLY when the email belongs to a real user, and only the admin's
//     bell/log shows it. The client still gets the same uniform 429.
//   * "Device" is the opaque __Host-vid browser identifier, shown as the first
//     DEVICE_ID_SHORT hex chars of its HMAC (stable, not reversible, enough to tell
//     devices apart). "New device" = this user has no earlier login_success from it.
//   * IP is shown in full to the recipient (primary admin) because the owner asked to
//     see it; the audit log keeps only the HMAC.
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { writeAuthLog } from "./authLog";
import { vidHashHex, ipBlockHashHex } from "./blocks";
import { emailTag } from "./keys";
import { notificationService } from "../services/notificationService";

const DEVICE_ID_SHORT = 12;
const RATE_LIMIT_NOTIFY_BUCKET_MS = 10 * 60_000; // at most one bell entry per user+device per 10 min

export interface EventCtx {
  ip: string;
  ua: string;
  country: string | null;
  /** Raw __Host-vid cookie value, when the browser has one. */
  vid: string | null;
  throttleKey: Uint8Array;
}

/** emailTag is base64url; aa_auth_log.email_tag is bound as hex (see authLog.ts). */
async function emailTagHex(key: Uint8Array, email: string): Promise<string> {
  const b64 = (await emailTag(key, email)).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Array.from(bin, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

const shortId = (hex: string | null) => (hex ? hex.slice(0, DEVICE_ID_SHORT) : "none");
const stamp = () => new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
const place = (c: EventCtx) => `IP ${c.ip}${c.country ? ` (${c.country})` : ""}`;

async function safely(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(JSON.stringify({
      event: "security_event_failed", label,
      detail: err instanceof Error ? err.message : String(err),
    }));
  }
}

/** A completed sign-in. Call AFTER the session exists. */
export function recordLoginSuccess(
  db: Db, c: EventCtx, user: { id: string; email: string; role: string },
): Promise<void> {
  return safely("login_success", async () => {
    const vidHash = c.vid ? await vidHashHex(c.throttleKey, c.vid) : null;
    // Decide BEFORE writing this login's own row, or every device would look known.
    const prior = vidHash
      ? await q1<{ n: number }>(db, sql`
          SELECT count(*)::int AS n FROM aa_auth_log
           WHERE event = 'login_success' AND status = 'success' AND user_id = ${user.id}::uuid
             AND device_id_hash = decode(${vidHash}, 'hex')`)
      : null;
    const isNew = !prior || prior.n === 0;
    const logId = await writeAuthLog(db, {
      event: "login_success", status: "success", userId: user.id,
      emailTagHex: await emailTagHex(c.throttleKey, user.email),
      ipHashHex: await ipBlockHashHex(c.throttleKey, c.ip),
      deviceIdHashHex: vidHash, ua: c.ua, reason: isNew ? "new_device" : "known_device",
      meta: { role: user.role },
    });
    await notificationService.createForAdmins(db, {
      type: "login_success",
      title: isNew ? "Sign-in from a NEW device" : "Sign-in from a known device",
      body: `${user.email} (${user.role}) · ${isNew ? "new device" : "known device"} · ` +
        `device ${shortId(vidHash)} · ${place(c)} · ${stamp()}`,
      href: "/users",
      dedupeKey: `login:${logId}`,
    });
  });
}

/**
 * A 429 on a sign-in path. Pass the email the caller was using (from the flow or the
 * request). Unknown emails are ignored entirely (no log, no bell).
 */
export function recordRateLimited(db: Db, c: EventCtx, rawEmail: string | null): Promise<void> {
  return safely("rate_limited", async () => {
    const email = (rawEmail ?? "").trim().toLowerCase();
    if (!email) return;
    const user = await q1<{ id: string; role: string }>(db, sql`
      SELECT id::text AS id, role FROM aa_users WHERE email = ${email}`);
    if (!user) return;
    const vidHash = c.vid ? await vidHashHex(c.throttleKey, c.vid) : null;
    await writeAuthLog(db, {
      event: "rate_limited", status: "rate_limited", userId: user.id,
      emailTagHex: await emailTagHex(c.throttleKey, email),
      ipHashHex: await ipBlockHashHex(c.throttleKey, c.ip),
      deviceIdHashHex: vidHash, ua: c.ua, reason: "sign_in_throttled",
    });
    const bucket = Math.floor(Date.now() / RATE_LIMIT_NOTIFY_BUCKET_MS);
    await notificationService.createForAdmins(db, {
      type: "rate_limited",
      title: "Sign-in rate limited",
      body: `${email} (${user.role}) was rate limited · device ${shortId(vidHash)} · ${place(c)} · ${stamp()}`,
      href: "/users",
      dedupeKey: `ratelimit:${user.id}:${vidHash ?? c.ip}:${bucket}`,
    });
  });
}

/** A user account was created by an admin. */
export function recordUserCreated(
  db: Db, c: EventCtx,
  created: { id: string; email: string; role: string },
  createdBy: { id: string; email: string | null },
): Promise<void> {
  return safely("user_created", async () => {
    const vidHash = c.vid ? await vidHashHex(c.throttleKey, c.vid) : null;
    await writeAuthLog(db, {
      event: "user_created", status: "success", userId: created.id,
      emailTagHex: await emailTagHex(c.throttleKey, created.email),
      ipHashHex: await ipBlockHashHex(c.throttleKey, c.ip),
      deviceIdHashHex: vidHash, ua: c.ua, reason: created.role,
      meta: { created_by: createdBy.id },
    });
    await notificationService.createForAdmins(db, {
      type: "user_created",
      title: "New user created",
      body: `${created.email} (${created.role}) created by ${createdBy.email ?? createdBy.id} · ` +
        `device ${shortId(vidHash)} · ${place(c)} · ${stamp()}`,
      href: "/users",
      dedupeKey: `user-created:${created.id}`,
    });
  });
}