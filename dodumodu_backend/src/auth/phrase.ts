// Phrase enrollment + verification — Appendix C ENROLL_PHRASE / ADVANCE.
// Dummy flows run a dummy Argon2id verify (verifyDummyPhrase) so they cost
// the same as real ones (spec §6). Lifecycle: reserve -> verify -> settle.
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { safeEqual } from "./crypto";
import { hashPhrase, verifyPhrase as argonVerify, verifyDummyPhrase } from "./argon2";
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

/** First login (stage='enroll_phrase'). Sets the hash iff none exists. */
export async function enrollPhrase(
  db: Db, secrets: VerifySecrets, flowToken: string,
  phrase: string, confirm: string, ip: string,
): Promise<{ next: Stage }> {
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
    const row = await q1<{ stage: Stage }>(db,
      sql`WITH setp AS (
         UPDATE aa_users SET phrase_hash = ${hash}
           FROM aa_auth_flows f
          WHERE f.id = ${flow.id} AND f.stage = 'enroll_phrase' AND f.expires_at > now()
            AND aa_users.id = f.user_id AND aa_users.phrase_hash IS NULL AND aa_users.is_active
          RETURNING aa_users.id, aa_users.role, aa_users.totp_enabled_at)
        UPDATE aa_auth_flows f
           SET stage = CASE WHEN setp.role <> 'admin' THEN 'ready'
             WHEN setp.totp_enabled_at IS NULL THEN 'totp_enroll' ELSE 'totp' END
          FROM setp
         WHERE f.id = ${flow.id} AND f.stage = 'enroll_phrase'
        RETURNING f.stage`);
    if (!row) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("phrase");
    }
    await clearKeys(db, [key]);
    return { next: row.stage };
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) throw e;
    await refund(db, reservation).catch(() => {});
    throw new AuthServerFaultError(e);
  }
}

/** Phrase check (stage='phrase'). */
export async function verifyPhrase(
  db: Db, secrets: VerifySecrets, flowToken: string, phrase: string, ip: string,
): Promise<{ next: Stage }> {
  const flow = await loadFlow(db, flowToken);
  if (!flow || flow.stage !== "phrase") throw new AuthRejectError("flow");
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
    if (flow.user_id === null) {
      await verifyDummyPhrase(phrase).catch(() => {});
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("phrase");
    }
    const urow = await q1<{ phrase_hash: string | null; is_active: boolean }>(db,
      sql`SELECT phrase_hash, is_active FROM aa_users WHERE id = ${flow.user_id}`);
    const ok = urow !== null && urow.is_active && urow.phrase_hash !== null &&
      await argonVerify(urow.phrase_hash, phrase).catch(() => false);
    if (!ok) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("phrase");
    }
    const row = await q1<{ stage: Stage }>(db,
      sql`UPDATE aa_auth_flows f
           SET stage = CASE
             WHEN f.stage = 'phrase' THEN CASE WHEN u.role <> 'admin' THEN 'ready'
               WHEN u.totp_enabled_at IS NULL THEN 'totp_enroll' ELSE 'totp' END
             ELSE 'ready' END
          FROM aa_users u
         WHERE f.id = ${flow.id} AND f.stage = 'phrase'
           AND f.expires_at > now() AND u.id = f.user_id AND u.is_active
        RETURNING f.stage`);
    if (!row) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("phrase");
    }
    await clearKeys(db, [key]);
    return { next: row.stage };
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) throw e;
    await refund(db, reservation).catch(() => {});
    throw new AuthServerFaultError(e);
  }
}
