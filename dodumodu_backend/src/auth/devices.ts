// Drift, device path, invites, guarded revoke — spec §5.3/5.4 (F3).
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { FLOW_TTL_SECS } from "./config";
import { randomToken } from "./crypto";
import { tokenHashHex, emailTag, deviceKey, strictKey } from "./keys";
import { reserve, noteFuse, refund } from "./throttle";
import { AuthLockedError, AuthServerFaultError } from "./errors";
import { tierFor } from "./sessions";

export interface DriftResult { driftCount: number; revoked: boolean; }

/**
 * SESSION_DRIFT: prefix changed mid-session. Session stays but turns strict
 * (audit ip_drift); country change also clears step-up. drift_count > 3
 * within the hour => delete the session (audit ip_drift_revoke).
 */
export async function driftSession(
  db: Db, sessionToken: string, prefix: string, country: string | null,
): Promise<DriftResult> {
  const hashHex = await tokenHashHex(sessionToken);
  const row = await q1<{ drift_count: number }>(db,
    sql`UPDATE aa_sessions SET
      tier = 'strict',
      stepup_until = CASE WHEN country IS DISTINCT FROM ${country} THEN NULL ELSE stepup_until END,
      ip_prefix = ${prefix}, country = ${country},
      drift_count = CASE WHEN drift_at IS NOT NULL AND drift_at > now() - interval '1 hour'
        THEN drift_count + 1 ELSE 1 END,
      drift_at = CASE WHEN drift_at IS NOT NULL AND drift_at > now() - interval '1 hour'
        THEN drift_at ELSE now() END
     WHERE id_hash = decode(${hashHex}, 'hex')
    RETURNING drift_count`);
  if (!row) return { driftCount: 0, revoked: true };
  if (row.drift_count > 3) {
    await q(db, sql`DELETE FROM aa_sessions WHERE id_hash = decode(${hashHex}, 'hex')`);
    return { driftCount: row.drift_count, revoked: true };
  }
  return { driftCount: row.drift_count, revoked: false };
}

export interface DeviceStartOutcome {
  flowToken: string;
  real: boolean; // true = active device matched; false = dummy flow
  tier: "normal" | "strict";
}

/**
 * POST /auth/device/start {email} + __Host-did. Always 202 + flow cookie.
 * Real phrase-stage flow only for a matching ACTIVE device with phrase AND
 * enrolled TOTP; otherwise a dummy phrase-stage flow (same shape, no email).
 * Tier comes from the device row already returned (no extra query).
 */
export async function deviceStart(
  db: Db, throttleKey: Uint8Array, email: string,
  deviceToken: string | null, ip: string, prefix: string,
  country: string | null, _ua: string,
): Promise<DeviceStartOutcome> {
  const tag = await emailTag(throttleKey, email);
  const deviceHashHex = deviceToken ? await tokenHashHex(deviceToken) : null;
  const found = await q1<{
    user_id: string; device_id: string | null; status: string | null;
    last_prefix: string | null; last_country: string | null;
  }>(db,
    sql`SELECT u.id::text AS user_id, d.id::text AS device_id, d.status,
      d.last_ip_prefix AS last_prefix, d.last_country AS last_country
     FROM aa_users u LEFT JOIN aa_admin_devices d
       ON d.user_id = u.id AND d.status = 'active' AND d.expires_at > now()
      AND ${deviceHashHex === null ? sql`FALSE` : sql`d.token_hash = decode(${deviceHashHex}, 'hex')`}
     WHERE u.email = ${email} AND u.is_active AND u.role = 'admin'
       AND u.phrase_hash IS NOT NULL AND u.totp_enabled_at IS NOT NULL`);
  const tier = tierFor(found?.last_prefix ?? null, found?.last_country ?? null,
    prefix, country, found?.device_id != null);
  // Lock tier: strict key for strict, device key for normal, pair key when anon.
  const key = !found?.device_id ? `otp:${tag}:${ip}`
    : tier === "strict" ? strictKey("device", tag, found.device_id, prefix)
    : deviceKey("device", tag, found.device_id);
  const lockTier = !found?.device_id ? "anon" : tier === "strict" ? "strict" : "device";
  let reservation;
  try {
    reservation = await reserve(db, key, lockTier);
  } catch (e) {
    if (e instanceof AuthLockedError) await noteFuse(db, tag).catch(() => {});
    throw e;
  }
  try {
    const token = randomToken();
    const hashHex = await tokenHashHex(token);
    if (found?.device_id) {
      const row = await q1<{ id: string }>(db,
        sql`INSERT INTO aa_auth_flows
          (token_hash, email, user_id, stage, via, device_id, expires_at, ip_prefix, country)
          SELECT decode(${hashHex}, 'hex'), ${email}, d.user_id, 'phrase', 'device',
            d.id, now() + (${FLOW_TTL_SECS}::int * interval '1 second'), ${prefix}, ${country}
           FROM aa_admin_devices d JOIN aa_users u
             ON u.id = d.user_id AND u.is_active AND u.role = 'admin'
          WHERE d.id = ${found.device_id} AND d.status = 'active' AND d.expires_at > now()
            AND u.email = ${email}
            AND u.phrase_hash IS NOT NULL AND u.totp_enabled_at IS NOT NULL
          RETURNING id::text AS id`);
      if (row) return { flowToken: token, real: true, tier };
    }
    // Dummy device-path flow: phrase stage, user_id NULL, via device.
    await q(db,
      sql`INSERT INTO aa_auth_flows
        (token_hash, email, user_id, stage, via, device_id, expires_at, ip_prefix, country)
        VALUES (decode(${hashHex}, 'hex'), ${email}, NULL, 'phrase', 'device', NULL,
          now() + (${FLOW_TTL_SECS}::int * interval '1 second'), ${prefix}, ${country})`);
    return { flowToken: token, real: false, tier };
  } catch (e) {
    if (e instanceof AuthLockedError) throw e;
    await refund(db, reservation).catch(() => {});
    throw new AuthServerFaultError(e);
  }
}
