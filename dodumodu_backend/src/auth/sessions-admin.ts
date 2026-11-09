// Admin session finish — Appendix F4 (active / pending->active / first claim).
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { SESSION_ABSOLUTE_SECS, SESSION_ABSOLUTE_SECS_STRICT, DEVICE_TTL_SECS, MAX_ACTIVE_DEVICES } from "./config";
import { logWarn, logError, swallow } from "../shared/logger";
import { randomToken } from "./crypto";
import { tokenHashHex } from "./keys";
import { AuthRejectError } from "./errors";
import { loadFlow } from "./flows";
import type { FinishedSession, FinishArgs } from "./sessions";

/** POST /auth/session for admins (F4). Handles active/pending/first-claim. */
export async function finishAdminSession(db: Db, a: FinishArgs): Promise<FinishedSession> {
  const flow = await loadFlow(db, a.flowToken);
  if (!flow || flow.stage !== "ready" || flow.user_id === null) {
    throw new AuthRejectError("flow");
  }
  // First-device claim needs a fresh token only when the window is open AND
  // the flow carries no device. Otherwise pass NULL (claim can't win anyway).
  const urow = await q1<{ window_open: boolean }>(db,
    sql`SELECT COALESCE(device_window_until > now(), false) AS window_open
      FROM aa_users WHERE id = ${flow.user_id}`);
  const claimToken = urow?.window_open ? randomToken() : null;
  const claimHashHex = claimToken ? await tokenHashHex(claimToken) : null;
  // Presented __Host-did at finish: hash-match ONLY a live active device owned
  // by this flow's user (email-path flows carry no device_id and the claim
  // window may already be spent). No token -> SQL `false` (no rows, no UPDATE).
  const byoHashHex = a.deviceToken ? await tokenHashHex(a.deviceToken) : null;
  const byoMatch = byoHashHex === null
    ? sql`false`
    : sql`d.token_hash = decode(${byoHashHex}, 'hex')`;
  // Fallback for a browser with no registered device (cleared cookies, new browser, new site
  // address): both factors already passed, so it is let in on a STRICT session and registered.
  const fallbackToken = randomToken();
  const fallbackHashHex = await tokenHashHex(fallbackToken);
  const absSecs = a.tier === "strict" ? SESSION_ABSOLUTE_SECS_STRICT : SESSION_ABSOLUTE_SECS;
  const sessionToken = randomToken();
  const sessionHashHex = await tokenHashHex(sessionToken);
  const run = (createdVia: string) => q1<{ user_id: string; device_issued: boolean; new_browser: boolean }>(db,
    sql`WITH f AS (
       UPDATE aa_auth_flows SET stage = 'done'
        WHERE id = ${flow.id} AND stage = 'ready' AND via <> 'resume' AND expires_at > now()
       RETURNING user_id, device_id, via),
      u AS (
       SELECT f.user_id, f.device_id, f.via, us.session_version
         FROM f JOIN aa_users us ON us.id = f.user_id
          AND us.is_active AND us.role = 'admin' AND us.totp_enabled_at IS NOT NULL),
      act AS (
       UPDATE aa_admin_devices d
          SET status = 'active', pending_until = NULL, last_seen_at = now(),
            expires_at = now() + (${DEVICE_TTL_SECS}::int * interval '1 second'),
            last_ip = ${a.ip}, last_ip_prefix = ${a.prefix}, last_country = ${a.country}
         FROM u
        WHERE d.id = u.device_id AND d.user_id = u.user_id
          AND d.status = 'pending' AND d.pending_until > now()
       RETURNING d.id),
      touch AS (
       UPDATE aa_admin_devices d
          SET last_ip = ${a.ip}, last_ip_prefix = ${a.prefix}, last_country = ${a.country}
         FROM u
        WHERE d.id = u.device_id AND d.user_id = u.user_id
          AND d.status = 'active' AND ${a.tier}::text = 'normal'
       RETURNING d.id),
      byo AS (
       UPDATE aa_admin_devices d
          SET last_seen_at = now(),
              last_ip = CASE WHEN ${a.tier}::text = 'normal' THEN ${a.ip} ELSE d.last_ip END,
              last_ip_prefix = CASE WHEN ${a.tier}::text = 'normal' THEN ${a.prefix} ELSE d.last_ip_prefix END,
              last_country = CASE WHEN ${a.tier}::text = 'normal' THEN ${a.country} ELSE d.last_country END
         FROM u
        WHERE u.device_id IS NULL AND d.user_id = u.user_id
          AND d.status = 'active' AND d.expires_at > now()
          AND ${byoMatch}
       RETURNING d.id),
      ok_dev AS (
       SELECT d.id FROM aa_admin_devices d JOIN u ON d.id = u.device_id AND d.user_id = u.user_id
        WHERE d.status = 'active' AND d.expires_at > now()
       UNION ALL SELECT id FROM act
       UNION ALL SELECT id FROM byo),
      claim AS (
       UPDATE aa_users SET device_window_until = NULL
        WHERE id IN (SELECT user_id FROM u
          WHERE device_id IS NULL AND ${claimHashHex}::text IS NOT NULL)
          AND device_window_until > now()
          AND NOT EXISTS (SELECT 1 FROM byo)
       RETURNING id),
      newdev AS (
       INSERT INTO aa_admin_devices
         (user_id, token_hash, status, label, created_via, expires_at, last_ip, last_ip_prefix, last_country)
       SELECT claim.id,
         ${claimHashHex === null ? sql`NULL::bytea` : sql`decode(${claimHashHex}, 'hex')`},
         'active', left(${a.ua}, 120), 'first_login',
         now() + (${DEVICE_TTL_SECS}::int * interval '1 second'),
         ${a.ip}, ${a.prefix}, ${a.country}
         FROM claim
       RETURNING id),
      adhoc AS (
       INSERT INTO aa_admin_devices
         (user_id, token_hash, status, label, created_via, expires_at, last_ip, last_ip_prefix, last_country)
       SELECT u.user_id, decode(${fallbackHashHex}, 'hex'), 'active', left(${a.ua}, 120), ${createdVia}::text,
         now() + (${DEVICE_TTL_SECS}::int * interval '1 second'),
         ${a.ip}, ${a.prefix}, ${a.country}
         FROM u
        WHERE NOT EXISTS (SELECT 1 FROM ok_dev) AND NOT EXISTS (SELECT 1 FROM newdev)
       RETURNING id)
      INSERT INTO aa_sessions
        (id_hash, user_id, session_version, absolute_expires_at, ip, ua,
         device_id, login_via, ip_prefix, country, tier)
      SELECT decode(${sessionHashHex}, 'hex'), u.user_id, u.session_version,
        now() + ((CASE WHEN EXISTS (SELECT 1 FROM adhoc) THEN ${SESSION_ABSOLUTE_SECS_STRICT}::int ELSE ${absSecs}::int END) * interval '1 second'),
        ${a.ip}, left(${a.ua}, 120),
        COALESCE((SELECT id FROM ok_dev LIMIT 1), (SELECT id FROM newdev), (SELECT id FROM adhoc)),
        u.via, ${a.prefix}, ${a.country},
        CASE WHEN EXISTS (SELECT 1 FROM adhoc) THEN 'strict' ELSE ${a.tier}::text END
       FROM u
      WHERE EXISTS (SELECT 1 FROM ok_dev) OR EXISTS (SELECT 1 FROM newdev) OR EXISTS (SELECT 1 FROM adhoc)
      RETURNING user_id::text AS user_id,
        (SELECT id FROM newdev) IS NOT NULL AS device_issued,
        (SELECT id FROM adhoc) IS NOT NULL AS new_browser`);
  let row;
  try {
    row = await run("new_browser");
  } catch (e) {
    // Deploy-order safety: if migration 0026 has not been applied yet the database still rejects
    // 'new_browser'. Never lock a correctly authenticated admin out over that: register the device
    // under an already-allowed type and say so in the log, so the missing migration is visible.
    const err = e as { code?: string; message?: string };
    if (err?.code !== "23514" && !String(err?.message).includes("created_via_check")) throw e;
    logError("migration_0026_not_applied", e);
    row = await run("operator");
  }
  if (!row) {
    // The code was right but no session could be issued: the flow was consumed by a concurrent
    // duplicate, or the account is no longer an active, enrolled admin.
    throw new AuthRejectError("session_not_issued");
  }
  if (row.new_browser) {
    logWarn("new_browser_device_registered", { tier: "strict" });
    // Keep the newest MAX_ACTIVE_DEVICES; retire the rest (their sessions end with them).
    await q1(db, sql`UPDATE aa_admin_devices SET status = 'revoked', revoked_at = now()
      WHERE user_id = ${flow.user_id}::uuid AND status = 'active'
        AND id NOT IN (SELECT id FROM aa_admin_devices
          WHERE user_id = ${flow.user_id}::uuid AND status = 'active' AND expires_at > now()
          ORDER BY last_seen_at DESC NULLS LAST, created_at DESC LIMIT ${MAX_ACTIVE_DEVICES})`)
      .catch(swallow("device_prune_failed"));
    return { sessionToken, deviceToken: fallbackToken };
  }
  return { sessionToken, deviceToken: row.device_issued ? claimToken : null };
}
