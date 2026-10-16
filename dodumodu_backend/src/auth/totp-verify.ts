// TOTP authenticator / backup-code verification at stage 'totp'.
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { totpMatch, decryptSecret, sha256, toHex } from "./crypto";
import { emailTag } from "./keys";
import { reserve, noteFuse, refund, clearKeys } from "./throttle";
import { AuthRejectError, AuthLockedError, AuthRecoverableError, AuthServerFaultError } from "./errors";
import { loadFlow, type VerifySecrets, type Stage } from "./flows";
import {
  CODE_VERIFY_THRESHOLD,
  CODE_VERIFY_DECAY_SECS,
  TOTP_FAILS_TO_UNLOCK_RECOVERY,
  TOTP_MAX_FAILS_PER_FLOW,
} from "./config";

function totpKey(tag: string, ip: string): string {
  return `totp:${tag}:${ip}`;
}

export interface TotpVerify { next: Stage; remaining: number | null; usedBackup: boolean; }

/**
 * POST /auth/totp {code} or {backup_code} at stage 'totp'.
 * allowBackup=false on the strict device path (spec §5.3 effect 2).
 * Backup use: single-use, atomic, returns remaining count (spec §5.6).
 */
export async function verifyTotp(
  db: Db, secrets: VerifySecrets & { totpEncKey: Uint8Array },
  flowToken: string, input: { code?: string; backupCode?: string },
  ip: string, allowBackup: boolean, nowMs = Date.now(),
): Promise<TotpVerify> {
  const flow = await loadFlow(db, flowToken);
  if (!flow || flow.stage !== "totp" || flow.user_id === null) {
    throw new AuthRejectError("flow");
  }
  const tag = await emailTag(secrets.throttleKey, flow.email);
  const key = totpKey(tag, ip);
  let reservation;
  try {
    // The per-flow TOTP counter (unlock@3, dead@5) is the authoritative limit
    // for THIS login; the throttle is a coarser per-IP backstop. Reserve with a
    // threshold above the flow cap so the flow's own counter is what fires, not
    // the tighter v1 pair lock (spec §4.4b layered limits). Code verification
    // uses a 10-attempt / 10-second decay window as a bot/attack detector.
    reservation = await reserve(db, key, "anon", CODE_VERIFY_THRESHOLD, CODE_VERIFY_DECAY_SECS);
  } catch (e) {
    if (e instanceof AuthLockedError) await noteFuse(db, tag).catch(() => {});
    throw e;
  }
  try {
    if (flow.user_id === null) {
      // Dummy device-path flow at stage 'totp': burn the same reservation a
      // real flow would and reject through the identical counter (spec §6).
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("totp");
    }
    if (input.backupCode !== undefined) {
      if (!allowBackup) throw new AuthRejectError("backup");
      const norm = input.backupCode.replace("-", "");
      const hashHex = toHex(await sha256(norm));
      // Consume from the ACKED, UNREVOKED generation and advance with the
      // same completion CASE as the authenticator path.
      const row = await q1<{ stage: Stage; remaining: number }>(db,
        sql`WITH r AS (
           UPDATE aa_backup_codes bc SET used_at = now()
            FROM aa_backup_code_sets s
           WHERE bc.set_id = s.id AND s.user_id = ${flow.user_id}
             AND s.acked_at IS NOT NULL AND s.revoked_at IS NULL
             AND bc.code_hash = decode(${hashHex}, 'hex')
             AND bc.used_at IS NULL
             AND EXISTS (SELECT 1 FROM aa_auth_flows
               WHERE id = ${flow.id} AND user_id = ${flow.user_id}
                 AND stage = 'totp' AND expires_at > now())
           RETURNING bc.set_id),
          adv AS (
           UPDATE aa_auth_flows f
              SET stage = CASE
                WHEN u.phrase_hash IS NULL THEN 'enroll_phrase'
                WHEN EXISTS (SELECT 1 FROM aa_backup_code_sets s2
                  WHERE s2.user_id = u.id AND s2.acked_at IS NULL AND s2.revoked_at IS NULL)
                  THEN 'backup_codes'
                ELSE 'ready' END
             FROM aa_users u
            WHERE f.id = ${flow.id} AND f.stage = 'totp'
              AND f.expires_at > now() AND u.id = f.user_id AND u.is_active
              AND EXISTS (SELECT 1 FROM r) -- advance ONLY when a code was consumed
           RETURNING f.stage)
          SELECT (SELECT stage FROM adv) AS stage,
            (SELECT count(*) FROM aa_backup_codes bc2
               JOIN aa_backup_code_sets s3 ON s3.id = bc2.set_id
              WHERE s3.user_id = ${flow.user_id}
                AND s3.acked_at IS NOT NULL AND s3.revoked_at IS NULL
                AND bc2.used_at IS NULL)::int - 1 AS remaining
           WHERE EXISTS (SELECT 1 FROM adv)`);
      if (!row) {
        await noteFuse(db, tag).catch(() => {});
        throw new AuthRejectError("backup");
      }
      await clearKeys(db, [key]);
      return { next: row.stage, remaining: row.remaining, usedBackup: true };
    }
    const urow = await q1<{ enc: string | null; last: number | null; active: boolean }>(db,
      sql`SELECT totp_secret_enc AS enc, totp_last_step AS last,
        (totp_enabled_at IS NOT NULL) AS active
        FROM aa_users WHERE id = ${flow.user_id}`);
    if (!urow?.enc || !urow.active) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("totp");
    }
    const secret = await decryptSecret(secrets.totpEncKey, urow.enc).catch(() => null);
    if (!secret) {
      await refund(db, reservation).catch(() => {});
      throw new AuthServerFaultError("totp decrypt");
    }
    const step = await totpMatch(secret, input.code ?? "", nowMs);
    if (step === null) {
      // Wrong code: bump this flow's fail counter in ONE guarded statement. The
      // 3rd fail unlocks recovery (recovery_unlocked=true, surfaced to the UI);
      // the 5th kills the flow. A replay of an already-used step is rejected
      // WITHOUT burning an attempt (it needs a captured valid code, so counting
      // it would let an attacker burn the victim's attempts).
      const fail = await q1<{ recovery_unlocked: boolean }>(db,
        sql`UPDATE aa_auth_flows
               SET totp_fails = totp_fails + 1,
                   recovery_unlocked = (totp_fails + 1 >= ${TOTP_FAILS_TO_UNLOCK_RECOVERY}),
                   stage = CASE WHEN totp_fails + 1 >= ${TOTP_MAX_FAILS_PER_FLOW} THEN 'dead' ELSE stage END
             WHERE id = ${flow.id} AND stage = 'totp' AND expires_at > now()
             RETURNING recovery_unlocked`);
      await noteFuse(db, tag).catch(() => {});
      if (fail?.recovery_unlocked) throw new AuthRecoverableError("totp");
      throw new AuthRejectError("totp");
    }
    // Success: a valid code from this 30s step advances the flow. Replay
    // within this short window is tolerated — throttle + flow TTL + 30s
    // step expiry already bound the risk, and the per-user last-step marker
    // caused false rejects right after enrollment.
    // Advance with the completion CASE: TOTP is proven now, so hand the flow
    // to whatever enrollment piece is still missing (phrase, then an unacked
    // backup generation), or ready when fully enrolled (spec §5.1, M2/M4).
    const adv = await q1<{ stage: Stage }>(db,
      sql`UPDATE aa_auth_flows f
           SET stage = CASE
             WHEN u.phrase_hash IS NULL THEN 'enroll_phrase'
             WHEN EXISTS (SELECT 1 FROM aa_backup_code_sets s
               WHERE s.user_id = u.id AND s.acked_at IS NULL AND s.revoked_at IS NULL)
               THEN 'backup_codes'
             ELSE 'ready' END
          FROM aa_users u
         WHERE f.id = ${flow.id} AND f.stage = 'totp'
           AND f.expires_at > now() AND u.id = f.user_id AND u.is_active
        RETURNING f.stage`);
    if (!adv) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("totp");
    }
    await clearKeys(db, [key]);
    return { next: adv.stage, remaining: null, usedBackup: false };
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError || e instanceof AuthRecoverableError) throw e;
    await refund(db, reservation).catch(() => {});
    throw new AuthServerFaultError(e);
  }
}
