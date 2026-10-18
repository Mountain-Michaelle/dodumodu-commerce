// TOTP + backup codes — spec §5.6, Appendices C/E3, realigned (M6/M8).
//   totp_enroll: start (secret shown once) -> confirm (first valid code ->
//     authenticator on; next stage is ALWAYS backup_codes with a NEW generation
//     else backup_codes with a NEW backup generation) in ONE statement.
//   backup_codes: codes are shown once at generation; ackBackupCodes marks the
//     generation acknowledged and moves the flow to ready. A user is
//     backup-ready iff an acked, unrevoked generation exists.
// Backup codes are XXXXX-XXXXX base32 (~50 bits), stored as SHA-256 hex in
// GENERATIONS (aa_backup_code_sets + aa_backup_codes); issuing a new generation
// revokes every earlier one. Refused on the strict device path (route-level).
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { BACKUP_CODE_COUNT } from "./config";
import { newTotpSecret, totpMatch, encryptSecret, decryptSecret,
  sha256, toHex } from "./crypto";
import { emailTag } from "./keys";
import { reserve, noteFuse, refund, clearKeys } from "./throttle";
import { AuthRejectError, AuthLockedError, AuthServerFaultError } from "./errors";
import { loadFlow, type VerifySecrets, type Stage } from "./flows";

function totpKey(tag: string, ip: string): string {
  return `totp:${tag}:${ip}`;
}

export interface TotpStart { secret: string; otpauthUri: string; }

/** Generate a fresh backup-code set (plain + hex hashes), for regenerate. */
export async function genBackupCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, backupCode);
  const hashes = await Promise.all(
    codes.map(async (c) => toHex(await sha256(c.replace("-", "")))));
  return { codes, hashes };
}

/** Begin enrollment: fresh secret stored pending, shown ONCE (reload = new flow). */
export async function totpEnrollStart(
  db: Db, secrets: VerifySecrets & { totpEncKey: Uint8Array },
  flowToken: string, accountEmail: string,
): Promise<TotpStart> {
  const flow = await loadFlow(db, flowToken);
  if (!flow || flow.stage !== "totp_enroll" || flow.user_id === null) {
    throw new AuthRejectError("flow");
  }
  const secret = newTotpSecret();
  const enc = await encryptSecret(secrets.totpEncKey, secret);
  const row = await q1<{ id: string }>(db,
    sql`UPDATE aa_auth_flows SET pending_totp_enc = ${enc}
      WHERE id = ${flow.id} AND stage = 'totp_enroll'
        AND pending_totp_enc IS NULL
        AND expires_at > now()
      RETURNING id::text AS id`);
  if (!row) throw new AuthRejectError("flow");
  const uri = `otpauth://totp/${encodeURIComponent(accountEmail)}` +
    `?secret=${secret}&issuer=${encodeURIComponent("dodumodu")}&digits=6&period=30`;
  return { secret, otpauthUri: uri };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function backupCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(7)); // 56 bits -> 10 b32 chars
  let bits = "";
  for (const b of r) bits += b.toString(2).padStart(8, "0");
  let s = "";
  for (let i = 0; i < 50; i += 5) s += B32[parseInt(bits.slice(i, i + 5), 2)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export interface TotpConfirm { next: Stage; backupCodes: string[]; }

/**
 * Confirm enrollment with the first valid code: authenticator on, then the
 * flow advances to backup_codes. Backup codes are returned
 * shown once (E3).
 */
export async function totpEnrollConfirm(
  db: Db, secrets: VerifySecrets & { totpEncKey: Uint8Array }, flowToken: string, code: string, ip: string,
  nowMs = Date.now(),
): Promise<TotpConfirm> {
  const flow = await loadFlow(db, flowToken);
  if (!flow || flow.stage !== "totp_enroll" || flow.user_id === null) {
    throw new AuthRejectError("flow");
  }
  const tag = await emailTag(secrets.throttleKey, flow.email);
  const key = totpKey(tag, ip);
  let reservation;
  try {
    reservation = await reserve(db, key, "anon");
  } catch (e) {
    if (e instanceof AuthLockedError) await noteFuse(db, tag).catch(() => {});
    throw e;
  }
  try {
    const prow = await q1<{ pending_totp_enc: string | null }>(db,
      sql`SELECT pending_totp_enc FROM aa_auth_flows WHERE id = ${flow.id}`);
    if (!prow?.pending_totp_enc) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("totp");
    }
    const blob = prow.pending_totp_enc;
    const secret = await decryptSecret(secrets.totpEncKey, blob).catch(() => null);
    if (!secret) {
      await refund(db, reservation).catch(() => {});
      throw new AuthServerFaultError("totp decrypt");
    }
    const step = await totpMatch(secret, code, nowMs);
    if (step === null) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("totp");
    }
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, backupCode);
    const hashes = await Promise.all(
      codes.map(async (c) => toHex(await sha256(c.replace("-", "")))));
    // Scalar hex params via sql.join — one array param serializes per-driver
    // (see the clearKeys probe). Same bytea[] semantics as REGEN_RECOVERY.
    const vals = sql.join(
      hashes.map((h) => sql`(decode(${h}, 'hex'))`), sql`, `);
    // One statement: enable TOTP, then advance. A user WITHOUT a phrase goes to
    // backup_codes (v2 order: TOTP -> backup -> ready); a recovery-
    // generation (revoking earlier ones). Backup codes are the only recovery
    // artifact; secret phrases were removed.
    // (this comment superseded: codes are issued on every enroll confirm).
    const row = await q1<{ stage: Stage; has_codes: boolean }>(db,
      sql`WITH e AS (
         UPDATE aa_users u
            SET totp_secret_enc = f.pending_totp_enc,
              totp_enabled_at = now()
           FROM aa_auth_flows f
          WHERE f.id = ${flow.id} AND f.stage = 'totp_enroll' AND f.expires_at > now()
            AND f.pending_totp_enc IS NOT NULL
            AND u.id = f.user_id AND u.totp_enabled_at IS NULL
          RETURNING u.id),
        adv AS (
         UPDATE aa_auth_flows f
            SET stage = 'backup_codes', pending_totp_enc = NULL,
                last_step_at = now()
           FROM e WHERE f.id = ${flow.id} AND f.stage = 'totp_enroll'
          RETURNING f.stage),
        rev AS (
         UPDATE aa_backup_code_sets SET revoked_at = now()
          WHERE revoked_at IS NULL
            AND user_id IN (SELECT id FROM e)),
        ns AS (
         INSERT INTO aa_backup_code_sets (user_id, generation)
         SELECT e.id, COALESCE((SELECT max(generation) + 1
                                  FROM aa_backup_code_sets b WHERE b.user_id = e.id), 1)
           FROM e
          RETURNING id),
        ins AS (
         INSERT INTO aa_backup_codes (set_id, code_hash)
         SELECT ns.id, v.code_hash FROM ns, (VALUES ${vals}) AS v(code_hash)
         RETURNING 1)
        SELECT (SELECT stage FROM adv) AS stage, EXISTS (SELECT 1 FROM ns) AS has_codes
         WHERE EXISTS (SELECT 1 FROM adv)`);
    if (!row) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("totp");
    }
    await clearKeys(db, [key]);
    return { next: row.stage, backupCodes: codes };
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) throw e;
    await refund(db, reservation).catch(() => {});
    throw new AuthServerFaultError(e);
  }
}

/**
 * POST /auth/backup-codes/ack (stage='backup_codes'). Marks the current
 * unacked, unrevoked generation acknowledged and moves the flow to ready.
 * The codes were shown once at generation; an admin regenerate is the only
 * way to see a fresh set. One guarded statement; no throttle (the flow token
 * is the capability and the stage is single-use).
 */
export async function ackBackupCodes(db: Db, flowToken: string): Promise<{ next: Stage }> {
  const flow = await loadFlow(db, flowToken);
  if (!flow || flow.stage !== "backup_codes" || flow.user_id === null) {
    throw new AuthRejectError("flow");
  }
  const row = await q1<{ stage: Stage }>(db,
    sql`WITH a AS (
         UPDATE aa_backup_code_sets SET acked_at = now()
          WHERE user_id = ${flow.user_id} AND acked_at IS NULL AND revoked_at IS NULL
          RETURNING id),
        adv AS (
         UPDATE aa_auth_flows SET stage = 'ready', last_step_at = now()
          WHERE id = ${flow.id} AND stage = 'backup_codes' AND expires_at > now()
          RETURNING stage)
        SELECT (SELECT stage FROM adv) AS stage
         WHERE EXISTS (SELECT 1 FROM adv) AND EXISTS (SELECT 1 FROM a)`);
  if (!row) throw new AuthRejectError("flow");
  return { next: row.stage };
}
