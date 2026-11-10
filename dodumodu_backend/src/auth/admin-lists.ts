// Administrator-facing lists of sessions and devices WITH the user each belongs to, searched and
// paged on the server (so the UI never silently drops rows that a client-side filter would miss).
//   * every row carries user_id + user_email (+ username, role) so an admin can find the account
//   * search matches email, username, user id, session id, device id, device label, user agent, ip
//   * only LIVE sessions are listed (same liveness rule as the session lookup); revoked devices are hidden
//   * read-only helpers + two scoped revokes; authorization is decided by the caller (routes.ts)
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { SESSION_LOOKUP_MAX_IDLE_SECS, ADMIN_LIST_DEFAULT_LIMIT, ADMIN_LIST_MAX_LIMIT } from "./config";
import { AuthRejectError } from "./errors";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListOpts { userId?: string; q?: string; limit?: number; offset?: number }

/** Clamp paging and escape LIKE wildcards so a search term is always a literal. */
export function normalizeList(opts: ListOpts) {
  const limit = Math.max(1, Math.min(ADMIN_LIST_MAX_LIMIT, Math.trunc(opts.limit ?? ADMIN_LIST_DEFAULT_LIMIT) || ADMIN_LIST_DEFAULT_LIMIT));
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0) || 0);
  const term = (opts.q ?? "").trim().slice(0, 80);
  const like = "%" + term.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
  const prefix = term.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
  return { limit, offset, term, like, prefix, userId: opts.userId && UUID_RE.test(opts.userId) ? opts.userId : "" };
}

export interface SessionRow {
  sid: string; user_id: string; user_email: string; username: string | null; role: string;
  device_id: string | null; device_label: string | null;
  created_at: string; last_seen_at: string; ip: string | null; ua: string | null; current: boolean;
}

export async function listSessionsAdmin(db: Db, opts: ListOpts, currentHashHex = "") {
  const n = normalizeList(opts);
  const where = sql`
    s.absolute_expires_at > now()
    AND s.last_seen_at > now() - (${SESSION_LOOKUP_MAX_IDLE_SECS}::int * interval '1 second')
    AND s.session_version = u.session_version
    AND (${n.userId} = '' OR s.user_id = NULLIF(${n.userId}, '')::uuid)
    AND (${n.term} = '' OR u.email ILIKE ${n.like} OR u.username ILIKE ${n.like}
         OR u.id::text ILIKE ${n.prefix} OR s.sid::text ILIKE ${n.prefix}
         OR s.device_id::text ILIKE ${n.prefix} OR d.label ILIKE ${n.like}
         OR s.ua ILIKE ${n.like} OR s.ip ILIKE ${n.like})`;
  const rows = await q<SessionRow>(db, sql`
    SELECT s.sid::text AS sid, u.id::text AS user_id, u.email AS user_email, u.username, u.role,
      s.device_id::text AS device_id, d.label AS device_label,
      s.created_at::text AS created_at, s.last_seen_at::text AS last_seen_at, s.ip, s.ua,
      (encode(s.id_hash, 'hex') = ${currentHashHex}) AS current
    FROM aa_sessions s JOIN aa_users u ON u.id = s.user_id
    LEFT JOIN aa_admin_devices d ON d.id = s.device_id
    WHERE ${where}
    ORDER BY s.last_seen_at DESC, s.sid LIMIT ${sql.raw(String(n.limit))} OFFSET ${sql.raw(String(n.offset))}`);
  const total = await q1<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM aa_sessions s JOIN aa_users u ON u.id = s.user_id
    LEFT JOIN aa_admin_devices d ON d.id = s.device_id WHERE ${where}`);
  return { sessions: rows, total: total?.n ?? rows.length, limit: n.limit, offset: n.offset };
}

export interface DeviceRow {
  id: string; user_id: string; user_email: string; username: string | null; role: string;
  status: string; label: string | null; created_via: string; last_seen_at: string; expires_at: string;
  last_ip_prefix: string | null; last_country: string | null; live_sessions: number;
}

export async function listDevicesAdmin(db: Db, opts: ListOpts) {
  const n = normalizeList(opts);
  const where = sql`
    d.status <> 'revoked'
    AND (${n.userId} = '' OR d.user_id = NULLIF(${n.userId}, '')::uuid)
    AND (${n.term} = '' OR u.email ILIKE ${n.like} OR u.username ILIKE ${n.like}
         OR u.id::text ILIKE ${n.prefix} OR d.id::text ILIKE ${n.prefix}
         OR d.label ILIKE ${n.like} OR d.last_ip_prefix ILIKE ${n.like} OR d.created_via ILIKE ${n.like})`;
  const rows = await q<DeviceRow>(db, sql`
    SELECT d.id::text AS id, u.id::text AS user_id, u.email AS user_email, u.username, u.role,
      d.status, d.label, d.created_via, d.last_seen_at::text AS last_seen_at, d.expires_at::text AS expires_at,
      d.last_ip_prefix, d.last_country,
      (SELECT count(*)::int FROM aa_sessions s WHERE s.device_id = d.id AND s.absolute_expires_at > now()) AS live_sessions
    FROM aa_admin_devices d JOIN aa_users u ON u.id = d.user_id
    WHERE ${where}
    ORDER BY d.last_seen_at DESC, d.id LIMIT ${sql.raw(String(n.limit))} OFFSET ${sql.raw(String(n.offset))}`);
  const total = await q1<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM aa_admin_devices d JOIN aa_users u ON u.id = d.user_id WHERE ${where}`);
  return { devices: rows, total: total?.n ?? rows.length, limit: n.limit, offset: n.offset };
}

/** End ONE session of a named user. The (sid, user) pair must match or nothing is touched. */
export async function revokeSessionOfUser(db: Db, userId: string, sid: string): Promise<void> {
  if (!UUID_RE.test(sid) || !UUID_RE.test(userId)) throw new AuthRejectError("session");
  const row = await q1<{ sid: string }>(db,
    sql`DELETE FROM aa_sessions WHERE sid = ${sid}::uuid AND user_id = ${userId}::uuid RETURNING sid::text AS sid`);
  if (!row) throw new AuthRejectError("session");
}

/** The device must belong to the named user (guards against pairing a foreign device id). */
export async function deviceBelongsTo(db: Db, userId: string, deviceId: string): Promise<boolean> {
  if (!UUID_RE.test(deviceId) || !UUID_RE.test(userId)) return false;
  const row = await q1<{ id: string }>(db,
    sql`SELECT id::text AS id FROM aa_admin_devices WHERE id = ${deviceId}::uuid AND user_id = ${userId}::uuid`);
  return !!row;
}
