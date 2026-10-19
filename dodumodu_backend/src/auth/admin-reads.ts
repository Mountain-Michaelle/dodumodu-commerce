// Admin read surface (spec §4.12/§5A.3/§8). List/detail for users,
// registry for the access matrix. Log/blocks/requests/notifications
// readers live in part 2 of this file's companion (admin-reads2).
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { REGISTRY } from "./registry";

export interface UserRow {
  id: string; email: string; username: string; firstName: string; lastName: string;
  role: string; isActive: boolean; isStaff: boolean; isSuperuser: boolean;
  lastLogin: string | null; dateJoined: string; permsVersion: number;
  permCount: number; enrolled: boolean;
}

export async function listUsers(db: Db, opts: { role?: string; active?: string; q?: string; limit?: number; offset?: number }) {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const conds: string[] = [];
  if (opts.role === "admin" || opts.role === "mono" || opts.role === "general") conds.push(`u.role = '${opts.role}'`);
  if (opts.active === "true") conds.push(`u.is_active = true`);
  if (opts.active === "false") conds.push(`u.is_active = false`);
  const term = (opts.q || "").trim().slice(0, 80);
  // where is allow-list built above (role/active literals only), never raw input.
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const search = term
    ? sql`AND (u.email ILIKE ${"%" + term + "%"} OR u.username ILIKE ${"%" + term + "%"})`
    : sql``;
  const rows = await q<UserRow>(db, sql`
    SELECT u.id::text AS id, u.email, u.username,
      COALESCE(u.first_name,'') AS "firstName", COALESCE(u.last_name,'') AS "lastName",
      u.role, u.is_active AS "isActive", u.is_staff AS "isStaff", u.is_superuser AS "isSuperuser",
      u.last_login::text AS "lastLogin", u.date_joined::text AS "dateJoined",
      u.perms_version AS "permsVersion",
      (SELECT count(*)::int FROM aa_user_permissions p WHERE p.user_id = u.id) AS "permCount",
      (u.totp_secret_enc IS NOT NULL) AS enrolled
    FROM aa_users u ${sql.raw(where)} ${search}
    ORDER BY u.date_joined DESC LIMIT ${sql.raw(String(limit))} OFFSET ${sql.raw(String(offset))}`);
  const total = await q1<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM aa_users u ${sql.raw(where)} ${search}`);
  return { users: rows, total: total?.n ?? rows.length };
}

export async function getUserDetail(db: Db, id: string) {
  const user = await q1<UserRow>(db, sql`
    SELECT u.id::text AS id, u.email, u.username,
      COALESCE(u.first_name,'') AS "firstName", COALESCE(u.last_name,'') AS "lastName",
      u.role, u.is_active AS "isActive", u.is_staff AS "isStaff", u.is_superuser AS "isSuperuser",
      u.last_login::text AS "lastLogin", u.date_joined::text AS "dateJoined",
      u.perms_version AS "permsVersion",
      (SELECT count(*)::int FROM aa_user_permissions p WHERE p.user_id = u.id) AS "permCount",
      (u.totp_secret_enc IS NOT NULL) AS enrolled
    FROM aa_users u WHERE u.id = ${id}::uuid`);
  if (!user) return null;
  const grants = await q<{ perm: string }>(db, sql`SELECT perm FROM aa_user_permissions WHERE user_id = ${id}::uuid ORDER BY perm`);
  const history = await q<{ at: string; action: string; status: string; perm: string | null; reason: string | null }>(db, sql`
    SELECT at::text AS at, action, status, perm, reason FROM aa_audit_log
    WHERE target_user_id = ${id}::uuid ORDER BY at DESC LIMIT 50`);
  return { user, grants: grants.map((r) => r.perm), history };
}

export async function listAuthLog(db: Db, opts: { event?: string; status?: string; q?: string; limit?: number; offset?: number }) {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const term = (opts.q || "").trim().slice(0, 80);
  const ev = (opts.event || "").trim().slice(0, 64);
  const st = (opts.status || "").trim().slice(0, 16);
  const rows = await q(db, sql`
    SELECT id, at::text AS at, event, status,
      user_id::text AS "userId", username_attempted AS "usernameAttempted",
      ua AS ua, device_label AS "deviceLabel", stage, reason
    FROM aa_auth_log
    WHERE (${ev} = '' OR event = ${ev})
      AND (${st} = '' OR status = ${st})
      AND (${term} = '' OR username_attempted ILIKE ${"%" + term + "%"} OR event ILIKE ${"%" + term + "%"} OR reason ILIKE ${"%" + term + "%"})
    ORDER BY at DESC LIMIT ${sql.raw(String(limit))} OFFSET ${sql.raw(String(offset))}`);
  return { rows };
}

export async function listBlocksAdmin(db: Db) {
  return q(db, sql`
    SELECT id::text AS id, kind, block_ref AS "blockRef", reason,
      created_at::text AS "createdAt", expires_at::text AS "expiresAt",
      lifted_at::text AS "liftedAt"
    FROM aa_blocks ORDER BY created_at DESC LIMIT 100`);
}

export async function listAccountRequests(db: Db, status = "open") {
  const st = status === "all" ? "" : status;
  return q(db, sql`
    SELECT id::text AS id, username_attempted AS "usernameAttempted", status,
      created_at::text AS "createdAt", resolved_at::text AS "resolvedAt"
    FROM aa_account_requests
    WHERE (${st} = '' OR status = ${st})
    ORDER BY created_at DESC LIMIT 100`);
}

export async function resolveAccountRequest(db: Db, id: string, action: "resolved" | "dismissed", actorId: string) {
  const rows = await q<{ id: string }>(db, sql`
    UPDATE aa_account_requests SET status = ${action}, resolved_at = now(), resolved_by = ${actorId}::uuid
    WHERE id = ${id}::uuid AND status = 'open' RETURNING id::text AS id`);
  return rows.length === 1;
}

export async function listNotifications(db: Db) {
  const open = await q<{ id: string; usernameAttempted: string; createdAt: string }>(db, sql`
    SELECT id::text AS id, username_attempted AS "usernameAttempted", created_at::text AS "createdAt"
    FROM aa_account_requests WHERE status = 'open' ORDER BY created_at DESC LIMIT 20`);
  const dead = await q<{ id: number; kind: string; attempts: number; lastError: string | null }>(db, sql`
    SELECT id, kind, attempts, last_error AS "lastError" FROM aa_alert_outbox
    WHERE status = 'dead' ORDER BY id DESC LIMIT 20`);
  const live = await q<{ id: string; kind: string; blockRef: string }>(db, sql`
    SELECT id::text AS id, kind, block_ref AS "blockRef" FROM aa_blocks
    WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC LIMIT 20`);
  return {
    openRequests: open, deadLetters: dead, liveBlocks: live,
    unread: open.length + dead.length + live.length,
  };
}

export function registryPayload() {
  return { registry: REGISTRY };
}
