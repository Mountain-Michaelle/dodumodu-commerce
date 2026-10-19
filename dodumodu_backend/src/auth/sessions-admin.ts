// Admin session finish — Appendix F4 (active / pending->active / first claim).
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { SESSION_ABSOLUTE_SECS, SESSION_ABSOLUTE_SECS_STRICT, DEVICE_TTL_SECS } from "./config";
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
  const absSecs = a.tier === "strict" ? SESSION_ABSOLUTE_SECS_STRICT : SESSION_ABSOLUTE_SECS;
  const sessionToken = randomToken();
  const sessionHashHex = await tokenHashHex(sessionToken);
  const row = await q1<{ user_id: string; device_issued: boolean }>(db,
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
      ok_dev AS (
       SELECT d.id FROM aa_admin_devices d JOIN u ON d.id = u.device_id AND d.user_id = u.user_id
        WHERE d.status = 'active' AND d.expires_at > now()
       UNION ALL SELECT id FROM act),
      claim AS (
       UPDATE aa_users SET device_window_until = NULL
        WHERE id IN (SELECT user_id FROM u
          WHERE device_id IS NULL AND ${claimHashHex}::text IS NOT NULL)
          AND device_window_until > now()
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
       RETURNING id)
      INSERT INTO aa_sessions
        (id_hash, user_id, session_version, absolute_expires_at, ip, ua,
         device_id, login_via, ip_prefix, country, tier)
      SELECT decode(${sessionHashHex}, 'hex'), u.user_id, u.session_version,
        now() + (${absSecs}::int * interval '1 second'),
        ${a.ip}, left(${a.ua}, 120),
        COALESCE((SELECT id FROM ok_dev LIMIT 1), (SELECT id FROM newdev)),
        u.via, ${a.prefix}, ${a.country}, ${a.tier}
       FROM u
      WHERE EXISTS (SELECT 1 FROM ok_dev) OR EXISTS (SELECT 1 FROM newdev)
      RETURNING user_id::text AS user_id,
        (SELECT id FROM newdev) IS NOT NULL AS device_issued`);
  if (!row) throw new AuthRejectError("flow");
  return { sessionToken, deviceToken: row.device_issued ? claimToken : null };
}
