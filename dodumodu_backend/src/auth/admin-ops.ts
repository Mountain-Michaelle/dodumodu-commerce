// Admin ops — spec §5.5/5.7. Permissions grant/revoke, user create,
// deactivate/demote (guarded, last-admin protected), force-logout,
// TOTP reset, step-up grant, own-sessions list/revoke. Every sensitive caller
// route must have verified a fresh step-up BEFORE calling these.
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { isV2Perm, STEPUP_WINDOW_SECS, STEPUP_WINDOW_SECS_STRICT,
  FIRST_DEVICE_WINDOW_HOURS, SESSION_IDLE_SECS_STAFF, ENROLL_WINDOW_HOURS } from "./config";
import { registryGet, cascadeOnRevoke, effectivePerms } from "./registry";
import { normalizeEmail } from "./crypto";
import { AuthRejectError, AuthServerFaultError, AuthForbiddenError } from "./errors";

/** Grant a permission to a user (admins implicitly hold all; no-op for them). */
/** Grant a permission. Enforced from the registry: adminOnly/role-disallowed
 * keys are rejected even if a caller forged the grant row. Requires section. */
export async function grantPerm(
  db: Db, userId: string, perm: string, grantedBy: string,
): Promise<void> {
  if (!isV2Perm(perm)) throw new AuthRejectError("perm");
  const entry = registryGet(perm);
  if (!entry) throw new AuthRejectError("perm");
  if (entry.adminOnly) throw new AuthRejectError("perm");
  const user = await q1<{ role: string }>(db,
    sql`SELECT role FROM aa_users WHERE id = ${userId}`);
  if (!user) throw new AuthRejectError("user");
  if (!(entry.roles as readonly string[]).includes(user.role)) throw new AuthRejectError("perm");
  // Dependency: section must already be held (or granted in the same call —
  // the caller grants sections first; here we require it).
  const held = await q<{ perm: string }>(db,
    sql`SELECT perm FROM aa_user_permissions WHERE user_id = ${userId}`);
  const heldKeys = held.map((r) => r.perm);
  for (const req of entry.requires) {
    if (!heldKeys.includes(req)) throw new AuthRejectError("perm");
  }
  await q(db,
    sql`INSERT INTO aa_user_permissions (user_id, perm, granted_by)
      VALUES (${userId}, ${perm}, ${grantedBy})
      ON CONFLICT (user_id, perm) DO NOTHING`);
  await q(db, sql`UPDATE aa_users SET perms_version = perms_version + 1 WHERE id = ${userId}`);
}

/** Revoke a permission. Revoking a section cascades to dependents. */
export async function revokePerm(db: Db, userId: string, perm: string): Promise<string[]> {
  if (!isV2Perm(perm)) throw new AuthRejectError("perm");
  const held = await q<{ perm: string }>(db,
    sql`SELECT perm FROM aa_user_permissions WHERE user_id = ${userId}`);
  const cascaded = cascadeOnRevoke(held.map((r) => r.perm), perm);
  if (cascaded.length > 0) {
    await q(db, sql`DELETE FROM aa_user_permissions
      WHERE user_id = ${userId} AND perm = ANY(ARRAY[${sql.join(cascaded.map((k) => sql`${k}`), sql`, `)}])`);
    await q(db, sql`UPDATE aa_users SET perms_version = perms_version + 1 WHERE id = ${userId}`);
  }
  return cascaded;
}

/**
 * Replace a user's whole grant set atomically (access console save).
 * Validates every key against the registry, normalizes dependencies
 * (section revoked => dependents removed), bumps perms_version once,
 * and returns the effective set + cascade list for the diff + audit rows.
 */
export async function replaceGrants(
  db: Db, userId: string, role: string, wanted: readonly string[],
): Promise<{ effective: string[]; removed: string[] }> {
  const normalized = new Set(effectivePerms(role, wanted));
  const current = await q<{ perm: string }>(db,
    sql`SELECT perm FROM aa_user_permissions WHERE user_id = ${userId}`);
  const currentKeys = current.map((r) => r.perm);
  const toAdd = [...normalized].filter((k) => !currentKeys.includes(k));
  const toRemove = currentKeys.filter((k) => !normalized.has(k));
  if (toRemove.length > 0) {
    await q(db, sql`DELETE FROM aa_user_permissions
      WHERE user_id = ${userId} AND perm = ANY(ARRAY[${sql.join(toRemove.map((k) => sql`${k}`), sql`, `)}])`);
  }
  for (const k of toAdd) {
    await q(db, sql`INSERT INTO aa_user_permissions (user_id, perm, granted_by)
      VALUES (${userId}, ${k}, ${userId}) ON CONFLICT (user_id, perm) DO NOTHING`);
  }
  if (toAdd.length > 0 || toRemove.length > 0) {
    await q(db, sql`UPDATE aa_users SET perms_version = perms_version + 1 WHERE id = ${userId}`);
  }
  return { effective: [...normalized], removed: toRemove };
}

/** Create a user (E5). Admin creation opens the first-device window. */
export async function createUser(
  db: Db, rawEmail: unknown, role: string, createdBy: string,
): Promise<string> {
  if (!["admin", "staff", "mono", "general"].includes(role)) throw new AuthRejectError("role"); // staff = legacy v1; mono/general = v2
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AuthRejectError("email");
  const row = await q1<{ id: string }>(db,
    sql`INSERT INTO aa_users (email, role, created_by, device_window_until, enroll_window_until)
      VALUES (${email}, ${role}, ${createdBy},
        CASE WHEN ${role} = 'admin'
          THEN now() + (${FIRST_DEVICE_WINDOW_HOURS}::int * interval '1 hour') END,
        now() + (${ENROLL_WINDOW_HOURS}::int * interval '1 hour'))
      ON CONFLICT (email) DO NOTHING
      RETURNING id::text AS id`);
  if (!row) throw new AuthRejectError("email"); // duplicate treated as 401
  return row.id;
}

/** Deactivate a user (guarded: refuses last active admin). */
export async function deactivateUser(db: Db, targetId: string): Promise<void> {
  const row = await q1<{ id: string }>(db,
    sql`SELECT aa_deactivate_guarded(${targetId})::text AS id`);
  if (!row?.id) throw new AuthRejectError("user");
}

/** Demote an admin to staff (guarded: refuses last active admin). */
export async function demoteAdmin(db: Db, targetId: string): Promise<void> {
  const row = await q1<{ id: string }>(db,
    sql`SELECT aa_demote_admin_guarded(${targetId})::text AS id`);
  if (!row?.id) throw new AuthRejectError("user");
}

/** Force-logout: bump session_version + delete all sessions. */
export async function forceLogout(db: Db, targetId: string): Promise<void> {
  await q(db,
    sql`WITH v AS (
       UPDATE aa_users SET session_version = session_version + 1
        WHERE id = ${targetId} RETURNING id)
      DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM v)`);
}

/** Another admin resets a lost authenticator (target re-enrolls next login).
 * Also opens a fresh enrollment window (or the next request is DUMMY — the
 * user could never reach totp_enroll) and revokes every backup generation
 * (the old codes must not outlive the authenticator they protected). */
export async function adminResetTotp(db: Db, targetId: string, actingAdminId: string): Promise<void> {
  const row = await q1<{ id: string }>(db,
    sql`WITH u AS (
       UPDATE aa_users SET totp_secret_enc = NULL, totp_enabled_at = NULL,
         totp_last_step = NULL, session_version = session_version + 1,
         enroll_window_until = now() + (${ENROLL_WINDOW_HOURS}::int * interval '1 hour')
        WHERE id = ${targetId} AND id <> ${actingAdminId} AND role = 'admin'
       RETURNING id),
      b AS (UPDATE aa_backup_code_sets SET revoked_at = now()
             WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM u)))
      s AS (DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM u))
      SELECT id::text AS id FROM u`);
  if (!row?.id) throw new AuthRejectError("user");
}

/** Patch names/role/active/staff (step-up in the caller). Role/active/staff
 * changes bump perms_version or session_version so access changes on the
 * next request without a logout. Last-admin safety enforced in SQL. */
export async function patchUser(
  db: Db, targetId: string,
  patch: { firstName?: string; lastName?: string; role?: string; isActive?: boolean; isStaff?: boolean },
): Promise<void> {
  if (patch.firstName !== undefined) {
    await q(db, sql`UPDATE aa_users SET first_name = left(${patch.firstName}, 80) WHERE id = ${targetId}::uuid`);
  }
  if (patch.lastName !== undefined) {
    await q(db, sql`UPDATE aa_users SET last_name = left(${patch.lastName}, 80) WHERE id = ${targetId}::uuid`);
  }
  if (patch.role !== undefined) {
    if (!["mono", "general", "admin"].includes(patch.role)) throw new AuthRejectError("role");
    const row = await q1<{ id: string | null; admins_left: number }>(db, sql`
      WITH locked AS (
        SELECT id FROM aa_users
        WHERE is_superuser AND is_active AND is_staff ORDER BY id FOR UPDATE),
      upd AS (
        UPDATE aa_users SET role = ${patch.role},
          is_superuser = (${patch.role} = 'admin'),
          perms_version = perms_version + 1
        WHERE id = ${targetId}::uuid
        RETURNING id::text AS id)
      SELECT (SELECT id FROM upd) AS id,
        (SELECT count(*)::int FROM locked) AS admins_left`);
    if (!row?.id) throw new AuthRejectError("user");
    if (row.admins_left === 0) throw new AuthForbiddenError("Last admin");
  }
  if (patch.isActive !== undefined) {
    const row = await q1<{ id: string }>(db, sql`
      SELECT aa_set_active_guarded(${targetId}::uuid, ${patch.isActive})::text AS id`);
    if (!row?.id) throw new AuthRejectError("user");
  }
  if (patch.isStaff !== undefined) {
    const row = await q1<{ id: string }>(db, sql`
      SELECT aa_set_staff_guarded(${targetId}::uuid, ${patch.isStaff})::text AS id`);
    if (!row?.id) throw new AuthRejectError("user");
  }
}

/** Step-up window (§5.5). strict tier = 120s, else 300s. */
export async function grantStepup(
  db: Db, sessionHashHex: string, tier: "normal" | "strict",
): Promise<void> {
  const secs = tier === "strict" ? STEPUP_WINDOW_SECS_STRICT : STEPUP_WINDOW_SECS;
  const row = await q1<{ stepup_until: string }>(db,
    sql`UPDATE aa_sessions SET stepup_until = now() + (${secs}::int * interval '1 second')
      WHERE id_hash = decode(${sessionHashHex}, 'hex') AND absolute_expires_at > now()
      RETURNING stepup_until::text AS stepup_until`);
  if (!row) throw new AuthServerFaultError("stepup");
}

/** Regenerate backup codes (needs step-up). Issues a NEW GENERATION — revoking
 * every earlier one — acked immediately (the admin just proved a step-up, so
 * the codes are usable at once on the login backup path). Returns 8 shown once. */
export async function regenerateBackupCodes(
  db: Db, userId: string, hashesHex: string[],
): Promise<void> {
  const vals = sql.join(hashesHex.map((h) => sql`(decode(${h}, 'hex'))`), sql`, `);
  await q(db,
    sql`WITH d AS (DELETE FROM aa_recovery_codes WHERE user_id = ${userId}),
      rev AS (
       UPDATE aa_backup_code_sets SET revoked_at = now()
        WHERE user_id = ${userId} AND revoked_at IS NULL),
      ns AS (
       INSERT INTO aa_backup_code_sets (user_id, generation, acked_at)
       SELECT ${userId}, COALESCE((SELECT max(generation) + 1
                                     FROM aa_backup_code_sets b WHERE b.user_id = ${userId}), 1),
         now()
        RETURNING id)
      INSERT INTO aa_backup_codes (set_id, code_hash)
      SELECT ns.id, v.code_hash FROM ns, (VALUES ${vals}) AS v(code_hash)`);
}

/** My sessions list (own only). */
export async function listSessions(
  db: Db, userId: string, currentHashHex: string,
) {
  return q<{
    sid: string; created_at: string; last_seen_at: string;
    ip: string | null; ua: string | null; current: boolean;
  }>(db,
    sql`SELECT sid::text AS sid, created_at::text AS created_at,
      last_seen_at::text AS last_seen_at, ip, ua,
      (encode(id_hash, 'hex') = ${currentHashHex}) AS current
      FROM aa_sessions
      WHERE user_id = ${userId} AND absolute_expires_at > now()
        AND last_seen_at > now() - (${SESSION_IDLE_SECS_STAFF}::int * interval '1 second')
      ORDER BY last_seen_at DESC`);
}

/** End one of my sessions by public sid (own only). */
export async function revokeSession(db: Db, sid: string, userId: string): Promise<void> {
  const row = await q1<{ sid: string }>(db,
    sql`DELETE FROM aa_sessions WHERE sid = ${sid} AND user_id = ${userId}
      RETURNING sid::text AS sid`);
  if (!row) throw new AuthRejectError("session");
}

/** End all my other sessions (keep current). */
export async function revokeOtherSessions(
  db: Db, userId: string, currentHashHex: string,
): Promise<number> {
  const rows = await q<{ sid: string }>(db,
    sql`DELETE FROM aa_sessions
      WHERE user_id = ${userId} AND encode(id_hash, 'hex') <> ${currentHashHex}
      RETURNING sid::text AS sid`);
  return rows.length;
}

/** End every session of a user (admin revoke-all). Does not bump
 * session_version — use forceLogout when that stronger invalidation is needed. */
export async function revokeAllSessions(
  db: Db, userId: string,
): Promise<number> {
  const rows = await q<{ sid: string }>(db,
    sql`DELETE FROM aa_sessions WHERE user_id = ${userId}
      RETURNING sid::text AS sid`);
  return rows.length;
}
