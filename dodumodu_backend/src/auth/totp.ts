// ===== FILE: <your-auth-dir>/totp.ts =====
// TOTP enrolment + backup codes.
//   start:   fresh pending secret (re-issuable while the flow is alive; only a
//            CONFIRMED secret ever reaches aa_users).
//   confirm: first valid code enables TOTP, issues a NEW backup generation
//            (revoking earlier ones) and moves the flow to backup_codes, in one statement.
//   ack:     marks the generation acknowledged and moves the flow to ready.
// Backup codes: XXXXX-XXXXX base32 (50 bits), stored as SHA-256 hex.
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { BACKUP_CODE_COUNT } from "./config";
import { newTotpSecret, totpMatch, encryptSecret, decryptSecret,
  sha256, toHex } from "./crypto";
import { emailTag } from "./keys";
import { reserve, noteFuse, refund, clearKeys } from "./throttle";
import { AuthRejectError, AuthLockedError, AuthServerFaultError } from "./errors";
import { loadFlow, type VerifySecrets, type Stage } from "./flows";

const ISSUER = "dodumodu";

function totpKey(tag: string, ip: string): string {
  return `totp:${tag}:${ip}`;
}

/** Single source of truth for backup-code normalisation (hash + lookup must match). */
export function normalizeBackupCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}
/** Authenticator codes are often pasted as "123 456". */
export function normalizeTotpCode(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

export interface TotpStart { secret: string; otpauthUri: string; expiresIn: number; }

/** Generate a fresh backup-code set (plain + hex hashes). */
export async function genBackupCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, backupCode);
  const hashes = await Promise.all(
    codes.map(async (c) => toHex(await sha256(normalizeBackupCode(c)))));
  return { codes, hashes };
}

/**
 * Begin (or re-issue) enrolment: fresh secret stored as pending. Calling again
 * while the flow is alive REPLACES the unconfirmed secret, so the old QR stops
 * working. expiresIn = real seconds left on the flow.
 */
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
  const row = await q1<{ ttl: number }>(db,
    sql`UPDATE aa_auth_flows SET pending_totp_enc = ${enc}
      WHERE id = ${flow.id} AND stage = 'totp_enroll'
        AND expires_at > now()
      RETURNING GREATEST(0, floor(extract(epoch FROM (expires_at - now()))))::int AS ttl`);
  if (!row) throw new AuthRejectError("flow");
  const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(accountEmail)}`;
  const uri = `otpauth://totp/${label}?secret=${secret}` +
    `&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
  return { secret, otpauthUri: uri, expiresIn: row.ttl };
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

/** Confirm enrolment with the first valid code; backup codes are returned shown-once. */
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
    const secret = await decryptSecret(secrets.totpEncKey, prow.pending_totp_enc).catch(() => null);
    if (!secret) {
      await refund(db, reservation).catch(() => {});
      throw new AuthServerFaultError("totp decrypt");
    }
    const step = await totpMatch(secret, normalizeTotpCode(code), nowMs);
    if (step === null) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("totp");
    }
    const { codes, hashes } = await genBackupCodes();
    // Scalar hex params via sql.join: one array param serialises per-driver.
    const vals = sql.join(
      hashes.map((h) => sql`(decode(${h}, 'hex'))`), sql`, `);
    // One statement: enable TOTP, advance the flow, revoke earlier backup
    // generations, insert the new generation and its codes.
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

/** POST /auth/backup-codes/ack (stage='backup_codes'): ack the generation, move to ready. */
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

/**
 * A reload on the "save your backup codes" step: the codes were shown once and are gone,
 * so issue a fresh set (the unacknowledged one is revoked, so only what the user now sees
 * is valid). One statement; only while the flow is at backup_codes. Touches last_step_at so
 * the resume window restarts.
 */
export async function reissueBackupCodes(db: Db, flowToken: string): Promise<{ codes: string[] }> {
  const flow = await loadFlow(db, flowToken);
  if (!flow || flow.stage !== "backup_codes" || flow.user_id === null) {
    throw new AuthRejectError("flow");
  }
  const { codes, hashes } = await genBackupCodes();
  const vals = sql.join(hashes.map((h) => sql`(decode(${h}, 'hex'))`), sql`, `);
  const row = await q1<{ ok: boolean }>(db,
    sql`WITH f AS (
         UPDATE aa_auth_flows SET last_step_at = now()
          WHERE id = ${flow.id} AND stage = 'backup_codes' AND expires_at > now()
          RETURNING user_id),
        rev AS (
         UPDATE aa_backup_code_sets SET revoked_at = now()
          WHERE revoked_at IS NULL AND acked_at IS NULL
            AND user_id IN (SELECT user_id FROM f)),
        ns AS (
         INSERT INTO aa_backup_code_sets (user_id, generation)
         SELECT f.user_id, COALESCE((SELECT max(generation) + 1
                                       FROM aa_backup_code_sets b WHERE b.user_id = f.user_id), 1)
           FROM f
          RETURNING id),
        ins AS (
         INSERT INTO aa_backup_codes (set_id, code_hash)
         SELECT ns.id, v.code_hash FROM ns, (VALUES ${vals}) AS v(code_hash)
         RETURNING 1)
        SELECT EXISTS (SELECT 1 FROM ns) AS ok WHERE EXISTS (SELECT 1 FROM f)`);
  if (!row?.ok) throw new AuthRejectError("flow");
  return { codes };
}