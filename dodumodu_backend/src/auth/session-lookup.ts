// Session lookup + touch (SESSION_LOOKUP; touch in waitUntil).
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { SESSION_LOOKUP_MAX_IDLE_SECS, SESSION_IDLE_SECS_STAFF,
  SESSION_IDLE_SECS_ADMIN, SESSION_IDLE_SECS_STRICT,
  DEVICE_TTL_SECS } from "./config";
import { tokenHashHex } from "./keys";
import type { Tier } from "./sessions";

export interface Session {
  userId: string; email: string; role: string; sid: string;
  deviceId: string | null; tier: Tier; perms: string[];
  permsVersion: number;
  needsTouch: boolean; idleSecs: number; stepupOk: boolean;
  prefix: string | null; country: string | null;
  driftCount: number;
}

/**
 * SESSION_LOOKUP: the ONLY query on an authenticated request (spec §6).
 * Called with the LARGEST idle (3600); the Worker enforces the per-role/tier
 * limit from idle_secs and NEVER deletes an idle row here. Expired = deny;
 * touch happens via touchSession in waitUntil when needs_touch.
 */
export async function lookupSession(db: Db, sessionToken: string): Promise<Session | null> {
  const hashHex = await tokenHashHex(sessionToken);
  const row = await q1<{
    id: string; email: string; role: string; sid: string;
    device_id: string | null; tier: Tier; ip_prefix: string | null; country: string | null;
    drift_count: number; perms: string[] | null; perms_version: number; needs_touch: boolean;
    idle_secs: number; stepup_ok: boolean;
  }>(db,
    sql`SELECT u.id::text AS id, u.email, u.role, s.sid::text AS sid,
      s.device_id::text AS device_id, s.tier, s.ip_prefix, s.country,
      s.drift_count,
      ARRAY(SELECT perm FROM aa_user_permissions WHERE user_id = u.id) AS perms,
      u.perms_version,
      s.last_seen_at < now() - interval '60 seconds' AS needs_touch,
      extract(epoch FROM now() - s.last_seen_at)::int AS idle_secs,
      COALESCE(s.stepup_until > now(), false) AS stepup_ok
     FROM aa_sessions s JOIN aa_users u ON u.id = s.user_id
    WHERE s.id_hash = decode(${hashHex}, 'hex')
      AND s.absolute_expires_at > now()
      AND s.last_seen_at > now() - (${SESSION_LOOKUP_MAX_IDLE_SECS}::int * interval '1 second')
      AND s.session_version = u.session_version
      AND u.is_active
      AND (u.role <> 'admin' OR EXISTS (SELECT 1 FROM aa_admin_devices d
        WHERE d.id = s.device_id AND d.status = 'active'))`);
  if (!row) return null;
  const limit = row.role === "staff" ? SESSION_IDLE_SECS_STAFF
    : row.tier === "strict" ? SESSION_IDLE_SECS_STRICT : SESSION_IDLE_SECS_ADMIN;
  if (row.idle_secs >= limit) return null; // deny, never delete here
  return {
    userId: row.id, email: row.email, role: row.role, sid: row.sid,
    deviceId: row.device_id, tier: row.tier, perms: row.perms ?? [],
    permsVersion: row.perms_version,
    needsTouch: row.needs_touch, idleSecs: row.idle_secs, stepupOk: row.stepup_ok,
    prefix: row.ip_prefix, country: row.country, driftCount: row.drift_count,
  };
}

/** Sliding touch, at most once a minute (called in waitUntil when needs_touch). */
export async function touchSession(db: Db, sessionToken: string): Promise<void> {
  const hashHex = await tokenHashHex(sessionToken);
  await q(db,
    sql`UPDATE aa_sessions SET last_seen_at = now()
      WHERE id_hash = decode(${hashHex}, 'hex')
        AND last_seen_at < now() - interval '60 seconds'`);
}

/** Sliding device touch, at most once a minute. */
export async function touchDevice(db: Db, deviceId: string): Promise<void> {
  await q(db,
    sql`UPDATE aa_admin_devices SET last_seen_at = now(),
        expires_at = now() + (${DEVICE_TTL_SECS}::int * interval '1 second')
      WHERE id = ${deviceId} AND status = 'active'
        AND last_seen_at < now() - interval '60 seconds'`);
}
