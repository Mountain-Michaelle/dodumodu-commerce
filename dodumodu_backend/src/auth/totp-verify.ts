// TOTP authenticator / backup-code verification at stage 'totp'.
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { totpMatch, decryptSecret, sha256, toHex } from "./crypto";
import { emailTag } from "./keys";
import { reserve, noteFuse, refund, clearKeys } from "./throttle";
import { AuthRejectError, AuthLockedError, AuthServerFaultError } from "./errors";
import { loadFlow, type VerifySecrets, type Stage } from "./flows";

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
    reservation = await reserve(db, key, "anon");
  } catch (e) {
    if (e instanceof AuthLockedError) await noteFuse(db, tag).catch(() => {});
    throw e;
  }
  try {
    if (input.backupCode !== undefined) {
      if (!allowBackup) throw new AuthRejectError("backup");
      const norm = input.backupCode.replace("-", "");
      const hashHex = toHex(await sha256(norm));
      const row = await q1<{ stage: Stage; remaining: number }>(db,
        sql`WITH r AS (
           UPDATE aa_recovery_codes SET used_at = now()
            WHERE user_id = ${flow.user_id} AND code_hash = decode(${hashHex}, 'hex')
              AND used_at IS NULL
              AND EXISTS (SELECT 1 FROM aa_auth_flows
                WHERE id = ${flow.id} AND user_id = ${flow.user_id}
                  AND stage = 'totp' AND expires_at > now())
            RETURNING user_id),
          adv AS (
           UPDATE aa_auth_flows SET stage = 'ready'
             FROM r WHERE aa_auth_flows.id = ${flow.id} AND aa_auth_flows.stage = 'totp'
            RETURNING aa_auth_flows.stage)
          SELECT (SELECT stage FROM adv) AS stage,
            (SELECT count(*) FROM aa_recovery_codes
              WHERE user_id = ${flow.user_id} AND used_at IS NULL)::int - 1 AS remaining
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
    if (step === null || (urow.last !== null && step <= urow.last)) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("totp");
    }
    const consumed = await q1<{ id: string }>(db,
      sql`UPDATE aa_users SET totp_last_step = ${step}
        WHERE id = ${flow.user_id}
          AND (totp_last_step IS NULL OR totp_last_step < ${step})
        RETURNING id::text AS id`);
    if (!consumed) {
      await noteFuse(db, tag).catch(() => {});
      throw new AuthRejectError("totp");
    }
    const adv = await q1<{ stage: Stage }>(db,
      sql`UPDATE aa_auth_flows f
           SET stage = CASE
             WHEN f.stage = 'phrase' THEN CASE WHEN u.role <> 'admin' THEN 'ready'
               WHEN u.totp_enabled_at IS NULL THEN 'totp_enroll' ELSE 'totp' END
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
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) throw e;
    await refund(db, reservation).catch(() => {});
    throw new AuthServerFaultError(e);
  }
}
