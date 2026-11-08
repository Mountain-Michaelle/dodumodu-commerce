// Lost-email recovery (spec §4.6, locked = Option A). An always-visible
// "recover by username" form: the server answers the SAME 202 {ok:true} for
// registered, unknown and malformed input — no enumeration oracle. For a
// REGISTERED handle the side effects are: one aa_account_requests row
// (deduped to a single open request per handle per 24 h) for the admin review
// queue, and at most one capped alert email to the account's address per
// cooldown. Rate limiting is a per-IP lockout (LOST_EMAIL_MAX_ATTEMPTS per
// round) that fires identically for every input shape. Nothing here reveals
// whether the handle exists: the response, status and shape never change.
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { emailTag } from "./keys";
import { reserve, sendCap } from "./throttle";
import { ipBlockHashHex } from "./blocks";
import { logInfo } from "./authLog";
import { notificationService } from "../services/notificationService";
import { LOST_EMAIL_MAX_ATTEMPTS, LOST_EMAIL_ALERT_COOLDOWN_HOURS } from "./config";

export interface LostEmailOutcome {
  /** Where to send the capped alert, or null (unknown handle, or cooldown). */
  alertTo: string | null;
}

export async function requestLostEmail(
  db: Db, throttleKey: Uint8Array, rawAttempted: unknown, ip: string,
): Promise<LostEmailOutcome> {
  // Per-IP lockout, keyed without the attempted handle so real and unknown
  // input share one counter (uniform). thr = attempts allowed per round; the
  // next attempt within the lock window throws AuthLockedError -> 429.
  // (The throttle key is plain text — base64url tags are fine here.)
  const ipTag = await emailTag(throttleKey, `lostip:${ip}`);
  await reserve(db, `lost:${ipTag}`, "anon", LOST_EMAIL_MAX_ATTEMPTS);
  const attempted = (typeof rawAttempted === "string" ? rawAttempted.trim().toLowerCase() : "")
    .slice(0, 254);
  if (attempted.length < 2) {
    // Malformed shapes still consumed the reservation and answer identically.
    return { alertTo: null };
  }
  const row = await q1<{ id: string; email: string; username: string | null }>(db,
    sql`SELECT id::text AS id, email, username FROM aa_users
         WHERE is_active AND (email = ${attempted} OR lower(username) = ${attempted})
         LIMIT 1`);
  if (!row) {
    await logInfo(db, {
      event: "lost_email", status: "info", usernameAttempted: attempted,
      ipHashHex: await ipBlockHashHex(throttleKey, ip),
    });
    return { alertTo: null };
  }
  // One open request per attempted handle per 24 h (dedupe via NOT EXISTS;
  // the Neon HTTP driver has no interactive transactions, so guard in-SQL).
  const ipHashHex = await ipBlockHashHex(throttleKey, ip);
  const created = await q<{ id: string }>(db, sql`
    INSERT INTO aa_account_requests (username_attempted, ip_hash)
    SELECT ${attempted}, decode(${ipHashHex}, 'hex')
     WHERE NOT EXISTS (
       SELECT 1 FROM aa_account_requests
        WHERE username_attempted = ${attempted} AND status = 'open'
          AND created_at > now() - interval '24 hours')
    RETURNING id::text AS id`);
  if (created[0]) {
    // Tell the admin bell. Never fails the (uniform) response.
    await notificationService.createForAdmins(db, {
      type: "account_request", title: "Lost-email recovery request",
      body: `A user asked for help recovering access: "${attempted}"`,
      href: "/users", dedupeKey: `account-request:${created[0].id}`,
    }).catch(() => {});
  }
  await logInfo(db, {
    event: "lost_email", status: "success", userId: row.id, usernameAttempted: attempted,
    ipHashHex,
  });
  const emailTagHash = await emailTag(throttleKey, row.email);
  const allowed = await sendCap(db, `lostalert:${emailTagHash}`,
    1, `${LOST_EMAIL_ALERT_COOLDOWN_HOURS} hours`);
  return { alertTo: allowed ? row.email : null };
}