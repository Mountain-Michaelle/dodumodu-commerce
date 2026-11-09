// OTP code verification — Appendix C VERIFY_OTP, owned by the service.
// One guarded SQL statement consumes the code and advances the flow, so
// races and replays fail (spec §4). Lifecycle: reserve -> verify -> settle.
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { codeMac, toHex } from "./crypto";
import { emailTag, pairKey, trustedPairKey, tokenHashHex } from "./keys";
import { ipBlockHashHex } from "./blocks";
import { isMissingSlotSchema } from "./challenge";
import { reserve, noteFuse, refund, clearKeys } from "./throttle";
import { AuthRejectError, AuthLockedError, AuthServerFaultError } from "./errors";
import { loadFlow, type VerifySecrets, type Stage } from "./flows";
import { CODE_VERIFY_THRESHOLD, CODE_VERIFY_DECAY_SECS } from "./config";
import { clearDeviceFailures, recordDeviceFailure } from "./device-failures";
import { swallow, logError } from "../shared/logger";

/**
 * POST /auth/code {code}. Real codes only verify on REAL flows (user_id NOT
 * NULL, stage='otp'); dummy flows burn a reservation and reject through the
 * SAME counters. Returns the next stage.
 */
export async function verifyCode(
  db: Db, secrets: VerifySecrets, flowToken: string, code: string, ip: string,
): Promise<{ next: Stage }> {
  const flow = await loadFlow(db, flowToken);
  if (!flow || flow.stage !== "otp") throw new AuthRejectError("flow");
  const tag = await emailTag(secrets.throttleKey, flow.email);
  // A recognized (trusted) browser has its own bucket, so a stranger on the same network can't spend it.
  const key = flow.trusted && flow.vid_hash ? trustedPairKey(tag, flow.vid_hash) : pairKey(tag, ip);
  // The challenge this browser was sent (one per browser: see challenge.ts).
  const slot = flow.vid_hash ? `v:${flow.vid_hash}` : `i:${await ipBlockHashHex(secrets.throttleKey, ip)}`;
  let reservation;
  try {
    reservation = await reserve(db, key, "anon", CODE_VERIFY_THRESHOLD, CODE_VERIFY_DECAY_SECS);
  } catch (e) {
    if (e instanceof AuthLockedError) await noteFuse(db, tag).catch(swallow("factors_best_effort_failed"));
    throw e;
  }
  try {
    if (flow.user_id === null) {
      await noteFuse(db, tag).catch(swallow("factors_best_effort_failed"));
      throw new AuthRejectError("code");
    }
    const macHex = toHex(await codeMac(secrets.otpKey, flow.user_id, code));
    const run = (withSlot: boolean) => q1<{ stage: Stage }>(db,
      sql`WITH used AS (
         UPDATE aa_login_challenges SET used_at = now()
          WHERE user_id = ${flow.user_id} AND used_at IS NULL AND expires_at > now()
            AND code_mac = decode(${macHex}, 'hex')
            ${withSlot ? sql`AND slot = ${slot}` : sql``}
            AND EXISTS (SELECT 1 FROM aa_auth_flows
              WHERE id = ${flow.id} AND user_id = ${flow.user_id}
                AND stage = 'otp' AND expires_at > now())
          RETURNING user_id)
        UPDATE aa_auth_flows f
           SET stage = CASE
             WHEN u.totp_enabled_at IS NOT NULL THEN 'totp'        -- enrolled -> normal login
             WHEN now() < u.enroll_window_until THEN 'totp_enroll' -- new user, window open -> enroll
             ELSE 'dead' END, last_step_at = now()                                      -- out of window, no TOTP -> dead
          FROM used JOIN aa_users u ON u.id = used.user_id
         WHERE f.id = ${flow.id} AND f.stage = 'otp'
        RETURNING f.stage`);
    let row;
    try {
      row = await run(true);
    } catch (e) {
      if (!isMissingSlotSchema(e)) throw e;          // migration 0027 not applied yet: old per-user lookup
      logError("migration_0027_not_applied", e);
      row = await run(false);
    }
    if (!row) {
      await noteFuse(db, tag).catch(swallow("factors_best_effort_failed"));
      await recordDeviceFailure(db, secrets.throttleKey, flow.id, ip).catch(swallow("factors_best_effort_failed"));
      throw new AuthRejectError("code");
    }
    await clearKeys(db, [key]);
    await clearDeviceFailures(db, flow.id);
    return { next: row.stage };
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) throw e;
    await refund(db, reservation).catch(swallow("factors_best_effort_failed"));
    throw new AuthServerFaultError(e);
  }
}

/** Re-exported so tests import flow helpers from one place. */
export { tokenHashHex };
