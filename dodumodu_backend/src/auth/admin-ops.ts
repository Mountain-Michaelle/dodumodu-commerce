// Admin ops — spec §5.5/5.7. Permissions grant/revoke, user create, phrase
// reset, deactivate/demote (guarded, last-admin protected), force-logout,
// TOTP reset, step-up grant, own-sessions list/revoke. Every sensitive caller
// route must have verified a fresh step-up BEFORE calling these.
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { isV2Perm, STEPUP_WINDOW_SECS, STEPUP_WINDOW_SECS_STRICT,
  FIRST_DEVICE_WINDOW_HOURS, SESSION_IDLE_SECS_STAFF } from "./config";
import { normalizeEmail, randomToken } from "./crypto";
import { assertPhraseFormat } from "./phrase";
import { tokenHashHex } from "./keys";
import { hashPhrase } from "./argon2";
import { AuthRejectError, AuthServerFaultError } from "./errors";

/** Grant a permission to a user (admins implicitly hold all; no-op for them). */
export async function grantPerm(
  db: Db, userId: string, perm: string, grantedBy: string,
): Promise<void> {
  if (!isV2Perm(perm)) throw new AuthRejectError("perm");
  await q(db,
    sql`INSERT INTO aa_user_permissions (user_id, perm, granted_by)
      VALUES (${userId}, ${perm}, ${grantedBy})
      ON CONFLICT (user_id, perm) DO NOTHING`);
}

/** Revoke a permission. */
export async function revokePerm(db: Db, userId: string, perm: string): Promise<void> {
  if (!isV2Perm(perm)) throw new AuthRejectError("perm");
  await q(db,
    sql`DELETE FROM aa_user_permissions WHERE user_id = ${userId} AND perm = ${perm}`);
}

/** Create a user (E5). Admin creation opens the first-device window. */
export async function createUser(
  db: Db, rawEmail: unknown, role: string, createdBy: string,
): Promise<string> {
  if (role !== "staff" && role !== "admin") throw new AuthRejectError("role");
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AuthRejectError("email");
  const row = await q1<{ id: string }>(db,
    sql`INSERT INTO aa_users (email, role, created_by, device_window_until)
      VALUES (${email}, ${role}, ${createdBy},
        CASE WHEN ${role} = 'admin'
          THEN now() + (${FIRST_DEVICE_WINDOW_HOURS}::int * interval '1 hour') END)
      ON CONFLICT (email) DO NOTHING
      RETURNING id::text AS id`);
  if (!row) throw new AuthRejectError("email"); // duplicate treated as 401
  return row.id;
}

/** Request a phrase reset: single-use link (admin-triggered). */
export async function createPhraseReset(
  db: Db, targetUserId: string, createdBy: string, ttlSecs = 900,
): Promise<string> {
  const token = randomToken();
  const hashHex = await tokenHashHex(token);
  const row = await q1<{ token_hash: string }>(db,
    sql`SELECT encode(aa_phrase_reset_create(
      ${targetUserId}, decode(${hashHex}, 'hex'), ${createdBy}, ${ttlSecs}), 'hex') AS token_hash`);
  if (!row?.token_hash) throw new AuthRejectError("user");
  return token;
}

/** Consume a reset token: sets the new phrase, bumps session_version (kills all sessions). */
export async function consumePhraseReset(
  db: Db, resetToken: string, newPhrase: string,
): Promise<void> {
  assertPhraseFormat(newPhrase);
  const hashHex = await tokenHashHex(resetToken);
  const newHash = await hashPhrase(newPhrase);
  const row = await q1<{ id: string }>(db,
    sql`WITH r AS (
       UPDATE aa_phrase_resets SET used_at = now()
        WHERE token_hash = decode(${hashHex}, 'hex')
          AND used_at IS NULL AND expires_at > now()
       RETURNING user_id)
      UPDATE aa_users u SET phrase_hash = ${newHash}, session_version = u.session_version + 1
       FROM r WHERE u.id = r.user_id AND u.is_active
      RETURNING u.id::text AS id`);
  if (!row) throw new AuthRejectError("reset");
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

/** Another admin resets a lost authenticator (target re-enrolls next login). */
export async function adminResetTotp(db: Db, targetId: string, actingAdminId: string): Promise<void> {
  const row = await q1<{ id: string }>(db,
    sql`WITH u AS (
       UPDATE aa_users SET totp_secret_enc = NULL, totp_enabled_at = NULL,
         totp_last_step = NULL, session_version = session_version + 1
        WHERE id = ${targetId} AND id <> ${actingAdminId} AND role = 'admin'
       RETURNING id),
      d AS (DELETE FROM aa_recovery_codes WHERE user_id IN (SELECT id FROM u)),
      s AS (DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM u))
      SELECT id::text AS id FROM u`);
  if (!row?.id) throw new AuthRejectError("user");
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

/** Regenerate backup codes (needs step-up). Replaces ALL, returns 8 shown once. */
export async function regenerateBackupCodes(
  db: Db, userId: string, hashesHex: string[],
): Promise<void> {
  const vals = sql.join(hashesHex.map((h) => sql`(decode(${h}, 'hex'))`), sql`, `);
  await q(db,
    sql`WITH d AS (DELETE FROM aa_recovery_codes WHERE user_id = ${userId})
      INSERT INTO aa_recovery_codes (user_id, code_hash)
      SELECT ${userId}, v.code_hash FROM (VALUES ${vals}) AS v(code_hash)`);
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
