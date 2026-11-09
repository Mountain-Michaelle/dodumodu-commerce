// Login challenges — Appendix C ISSUE_CHALLENGE, owned by the service layer.
// One row per user, reused. Unexpired row = same code (idempotent send):
// the code is derived from (OTP_KEY, user_id, nonce) so a resend recomputes
// the SAME code and nothing sensitive is stored (Appendix D).
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { OTP_TTL_SECS, OTP_RESEND_COOLDOWN_SECS, OTP_RESEND_MAX } from "./config";
import { deriveCode, codeMac, toHex, fromHex } from "./crypto";
import { AuthServerFaultError } from "./errors";
import { logError, swallow } from "../shared/logger";

export interface ChallengeIssue {
  nonceHex: string;
  sendNow: boolean;
  sendCount: number;
}

/** True when the database does not have migration 0027 yet (no `slot` column / unique index). */
export function isMissingSlotSchema(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "42703" || code === "42P10";
}

/**
 * One challenge per (user, slot). A slot is one BROWSER: 'v:<vid hash>' (or 'i:<network hash>' for a
 * cookie-less client). A request from another browser can therefore never replace the code that is
 * already in the real user's inbox. If migration 0027 has not been applied yet this falls back to the
 * old one-challenge-per-user behaviour (and says so in the log) instead of breaking login.
 */
export async function issueChallenge(
  db: Db, userId: string, otpKey: Uint8Array,
  forceNew = false, slot = "",
): Promise<ChallengeIssue> {
  try {
    return await issueChallengeSlot(db, userId, otpKey, forceNew, slot);
  } catch (e) {
    if (!isMissingSlotSchema(e)) throw e;
    logError("migration_0027_not_applied", e);
    return issueChallengeLegacy(db, userId, otpKey, forceNew);
  }
}

async function issueChallengeSlot(
  db: Db, userId: string, otpKey: Uint8Array, forceNew: boolean, slot: string,
): Promise<ChallengeIssue> {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceHex = toHex(nonce);
  const candidateCode = await deriveCode(otpKey, userId, nonce);
  const candidateMacHex = toHex(await codeMac(otpKey, userId, candidateCode));
  if (forceNew) {
    await q(db, sql`DELETE FROM aa_login_challenges WHERE user_id = ${userId} AND slot = ${slot}`);
    // Housekeeping so per-browser rows cannot accumulate: this user's long-expired ones.
    void q(db, sql`DELETE FROM aa_login_challenges WHERE user_id = ${userId} AND expires_at < now() - interval '1 hour'`)
      .catch(swallow("challenge_prune_failed"));
  }
  const row = await q1<{ nonce: string; send_count: number; send_now: boolean }>(
    db,
    sql`INSERT INTO aa_login_challenges AS c
      (user_id, slot, nonce, code_mac, expires_at, send_count, last_sent_at)
      VALUES (${userId}, ${slot}, decode(${nonceHex}, 'hex'), decode(${candidateMacHex}, 'hex'),
        now() + (${OTP_TTL_SECS}::int * interval '1 second'), 1, now())
      ON CONFLICT (user_id, slot) DO UPDATE SET
        nonce = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
          THEN EXCLUDED.nonce ELSE c.nonce END,
        code_mac = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
          THEN EXCLUDED.code_mac ELSE c.code_mac END,
        expires_at = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
          THEN EXCLUDED.expires_at ELSE c.expires_at END,
        used_at = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
          THEN NULL ELSE c.used_at END,
        send_count = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL THEN 1
          WHEN c.send_count < ${OTP_RESEND_MAX}::int
           AND now() - c.last_sent_at >= (${OTP_RESEND_COOLDOWN_SECS}::int * interval '1 second')
          THEN c.send_count + 1 ELSE c.send_count END,
        last_sent_at = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
            OR (c.send_count < ${OTP_RESEND_MAX}::int
              AND now() - c.last_sent_at >= (${OTP_RESEND_COOLDOWN_SECS}::int * interval '1 second'))
          THEN now() ELSE c.last_sent_at END
      RETURNING encode(nonce, 'hex') AS nonce, send_count,
        (last_sent_at = now()) AS send_now`,
  );
  if (!row) throw new AuthServerFaultError("issue challenge returned no row");
  return { nonceHex: row.nonce, sendNow: row.send_now, sendCount: row.send_count };
}

async function issueChallengeLegacy(
  db: Db, userId: string, otpKey: Uint8Array,
  forceNew = false,
): Promise<ChallengeIssue> {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceHex = toHex(nonce);
  const candidateCode = await deriveCode(otpKey, userId, nonce);
  const candidateMacHex = toHex(await codeMac(otpKey, userId, candidateCode));

  // When the caller explicitly requests a new code (POST /auth/request),
  // invalidate any existing challenge and issue a fresh one unconditionally.
  // Resend (POST /auth/resend) calls with forceNew=false and keeps the cooldown.
  if (forceNew) {
    await q(db, sql`DELETE FROM aa_login_challenges WHERE user_id = ${userId}`);
    const row = await q1<{ nonce: string; send_count: number; send_now: boolean }>(
      db,
      sql`INSERT INTO aa_login_challenges AS c
        (user_id, nonce, code_mac, expires_at, send_count, last_sent_at)
        VALUES (${userId}, decode(${nonceHex}, 'hex'), decode(${candidateMacHex}, 'hex'),
          now() + (${OTP_TTL_SECS}::int * interval '1 second'), 1, now())
        RETURNING encode(nonce, 'hex') AS nonce, send_count,
          (last_sent_at = now()) AS send_now`,
    );
    if (!row) throw new AuthServerFaultError("issue challenge returned no row");
    return { nonceHex: row.nonce, sendNow: row.send_now, sendCount: row.send_count };
  }

  const row = await q1<{ nonce: string; send_count: number; send_now: boolean }>(
    db,
    sql`INSERT INTO aa_login_challenges AS c
      (user_id, nonce, code_mac, expires_at, send_count, last_sent_at)
      VALUES (${userId}, decode(${nonceHex}, 'hex'), decode(${candidateMacHex}, 'hex'),
        now() + (${OTP_TTL_SECS}::int * interval '1 second'), 1, now())
      ON CONFLICT (user_id) DO UPDATE SET
        nonce = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
          THEN EXCLUDED.nonce ELSE c.nonce END,
        code_mac = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
          THEN EXCLUDED.code_mac ELSE c.code_mac END,
        expires_at = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
          THEN EXCLUDED.expires_at ELSE c.expires_at END,
        used_at = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
          THEN NULL ELSE c.used_at END,
        send_count = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL THEN 1
          WHEN c.send_count < ${OTP_RESEND_MAX}::int
           AND now() - c.last_sent_at >= (${OTP_RESEND_COOLDOWN_SECS}::int * interval '1 second')
          THEN c.send_count + 1 ELSE c.send_count END,
        last_sent_at = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
            OR (c.send_count < ${OTP_RESEND_MAX}::int
              AND now() - c.last_sent_at >= (${OTP_RESEND_COOLDOWN_SECS}::int * interval '1 second'))
          THEN now() ELSE c.last_sent_at END
      RETURNING encode(nonce, 'hex') AS nonce, send_count,
        (last_sent_at = now()) AS send_now`,
  );
  if (!row) throw new AuthServerFaultError("issue challenge returned no row");
  return { nonceHex: row.nonce, sendNow: row.send_now, sendCount: row.send_count };
}

/** Recompute the emailable code from the STORED nonce (resend = same code). */
export async function deriveChallengeCode(
  otpKey: Uint8Array, userId: string, nonceHex: string,
): Promise<string> {
  return deriveCode(otpKey, userId, fromHex(nonceHex));
}
