// Device invites + guarded revoke — spec §5.4 (F3, atomic wrappers in 0017).
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { DEVICE_PENDING_SECS, DEVICE_INVITE_TTL_SECS, ADMIN_DEVICE_MAX,
  DEVICE_TTL_SECS } from "./config";
import { randomToken } from "./crypto";
import { tokenHashHex } from "./keys";
import { AuthRejectError } from "./errors";

/** Create a single-use invite (needs step-up in the caller). Returns the token. */
export async function createDeviceInvite(
  db: Db, targetAdminId: string, createdBy: string,
): Promise<string> {
  const token = randomToken();
  const hashHex = await tokenHashHex(token);
  const row = await q1<{ token_hash: string }>(db,
    sql`SELECT aa_device_invite_create(
      ${targetAdminId}, ${createdBy}, decode(${hashHex}, 'hex'),
      ${DEVICE_INVITE_TTL_SECS}) AS token_hash`);
  if (!row?.token_hash) throw new AuthRejectError("invite");
  return token;
}

/** Accept an invite on a new browser: registers a PENDING device (sets cookie). */
export async function acceptDeviceInvite(
  db: Db, inviteToken: string, ua: string,
): Promise<{ deviceToken: string; deviceId: string }> {
  const inviteHashHex = await tokenHashHex(inviteToken);
  const deviceToken = randomToken();
  const deviceHashHex = await tokenHashHex(deviceToken);
  const row = await q1<{ id: string }>(db,
    sql`WITH i AS (
       UPDATE aa_device_invites SET used_at = now()
        WHERE token_hash = decode(${inviteHashHex}, 'hex')
          AND used_at IS NULL AND expires_at > now()
       RETURNING user_id, created_by)
      INSERT INTO aa_admin_devices
        (user_id, token_hash, status, label, created_via, pending_until, expires_at)
      SELECT i.user_id, decode(${deviceHashHex}, 'hex'), 'pending', left(${ua}, 120),
        CASE WHEN i.created_by = i.user_id THEN 'invite' ELSE 'admin_invite' END,
        now() + (${DEVICE_PENDING_SECS}::int * interval '1 second'),
        now() + (${DEVICE_TTL_SECS}::int * interval '1 second')
       FROM i
      WHERE (SELECT count(*) FROM aa_admin_devices d
        WHERE d.user_id = i.user_id AND d.status IN ('active','pending')) < ${ADMIN_DEVICE_MAX}
      RETURNING id::text AS id`);
  if (!row) throw new AuthRejectError("invite");
  return { deviceToken, deviceId: row.id };
}

/** Revoke a device (needs step-up in the caller). Refuses own last active. */
export async function revokeDevice(
  db: Db, deviceId: string, ownerId: string, actingIsOtherAdmin: boolean,
): Promise<void> {
  const row = await q1<{ id: string }>(db,
    sql`SELECT aa_device_revoke_guarded(
      ${deviceId}, ${ownerId}, ${actingIsOtherAdmin})::text AS id`);
  if (!row?.id) throw new AuthRejectError("device");
}

/** My devices for the devices page. */
export async function listDevices(db: Db, userId: string) {
  return q<{
    id: string; status: string; label: string | null; created_via: string;
    last_seen_at: string; expires_at: string;
    last_ip_prefix: string | null; last_country: string | null;
  }>(db,
    sql`SELECT id::text AS id, status, label, created_via,
      last_seen_at::text AS last_seen_at, expires_at::text AS expires_at,
      last_ip_prefix, last_country
     FROM aa_admin_devices WHERE user_id = ${userId} AND status <> 'revoked'
     ORDER BY last_seen_at DESC`);
}
