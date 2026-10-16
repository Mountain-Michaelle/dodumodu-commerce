// Phrase enrollment — Appendix C ENROLL_PHRASE, realigned (M2/M4): the phrase
// is an ENROLLMENT factor, never a login step. The flow only reaches
// enroll_phrase AFTER TOTP was enrolled in the same flow (v2 order: TOTP ->
// phrase -> backup -> ready), so enrollment always hands the user to the
// backup_codes stage with a fresh generation (revoking any earlier one).
// Dummy flows can never reach this stage; nothing here verifies a phrase at
// login (the old stage='phrase' path was removed with the login realignment).
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { safeEqual } from "./crypto";
import { hashPhrase } from "./argon2";
import { genBackupCodes } from "./totp";
import { emailTag } from "./keys";
import { reserve, noteFuse, refund, clearKeys } from "./throttle";
import { AuthRejectError, AuthLockedError, AuthServerFaultError } from "./errors";
import { loadFlow, type VerifySecrets, type Stage } from "./flows";

function phraseKey(tag: string, ip: string): string {
  return `phrase:${tag}:${ip}`;
}

/** Spec §5.2.1: 12-64 chars, no spaces, any symbol. Guards every SET path. */
export function assertPhraseFormat(phrase: string): void {
  if (phrase.length < 12 || phrase.length > 64 || /\s/.test(phrase)) {
    throw new AuthRejectError("phrase");
  }
}

/**
 * First login (stage='enroll_phrase'). Sets the hash iff none exists AND TOTP
 * is already enrolled; then advances to backup_codes and issues a NEW backup
 * generation (shown once). Backfill/legacy users without TOTP are rejected —
 * they re-enroll TOTP first (the stage machine routes them here anyway).
 */
export async function enrollPhrase(
  db: Db, secrets: VerifySecrets, flowToken: string,
  phrase: string, confirm: string, ip: string,
): Promise<{ next: Stage; backupCodes: string[] }> {
  if (!safeEqual(phrase, confirm)) throw new AuthRejectError("phrase");
  assertPhraseFormat(phrase);
  const flow = await loadFlow(db, flowToken);
  if (!flow || flow.stage !== "enroll_phrase" || flow.user_id === null) {
    throw new AuthRejectError("flow");
  }
  const tag = await emailTag(secrets.throttleKey, flow.email);
  const key = phraseKey(tag, ip);
  let reservation;
  try {
    reservation = await reserve(db, key, "anon");
  } catch (e) {
    if (e instanceof AuthLockedError) await noteFuse(db, tag).catch(() => {});
    throw e;
  }
  try {
    const hash = await hashPhrase(phrase);
    const { codes, hashes } = await genBackupCodes();
    const vals = sql.join(
      hashes.map((h) => sql`(decode(${h}, 'hex'))`), sql`, `);
    const row = await q1<{ stage: Stage }>(db,
      sql`WITH setp AS (
         UPDATE aa_users SET phrase_hash = ${hash}
           FROM aa_auth_flows f
          WHERE f.id = ${flow.id} AND f.stage = 'enroll_phrase' AND f.expires_at > now()
            AND aa_users.id = f.user_id AND aa_users.phrase_hash IS NULL
            AND aa_users.is_active AND aa_users.totp_enabled_at IS NOT NULL
          RETURNING aa_users.id),
        adv AS (
         UPDATE aa_auth_flows f SET stage = 'backup_codes'
           FROM setp
          WHERE f.id = ${flow.id} AND f.stage = 'enroll_phrase'
         RETURNING f.stage),
        rev AS (
         UPDATE aa_backup_code_sets SET revoked_at = now()
          WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM setp)),
        ns AS (
         INSERT INTO aa_backup_code_sets (user_id, generation)
         SELECT setp.id, COALESCE((SELECT max(generation) + 1
                                     FROM aa_backup_code_sets b WHERE b.user_id = setp.id), 1)
           FROM setp
          RETURNING id),
        ins AS (
         INSERT INTO aa_backup_codes (set_id, code_hash)
         SELECT ns.id, v.code_hash FROM ns, (VALUES ${vals}) AS v(code_hash)
         RETURNING 1)
        SELECT (SELECT stage FROM adv) AS stage WHERE EXISTS (SELECT 1 FROM adv)`);
    if (!row) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("phrase");
    }
    await clearKeys(db, [key]);
    return { next: row.stage, backupCodes: codes };
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) throw e;
    await refund(db, reservation).catch(() => {});
    throw new AuthServerFaultError(e);
  }
}
