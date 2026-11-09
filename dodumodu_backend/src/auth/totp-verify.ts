// TOTP authenticator / backup-code verification at stage 'totp'.
//
// Guarantees (each one is pinned by a test — see src/auth/totp*.test.ts,
// recovery.test.ts, device-trust.test.ts):
//  * A TOTP step is consumed ATOMICALLY with the flow advance (one SQL statement):
//    there is no state where the step is burned but the user is not logged in.
//  * Replay: a step that was already consumed is rejected for any OTHER browser/flow,
//    without burning an attempt on the recovery counters. The SAME flow or the SAME
//    browser (__Host-vid) may repeat it, so a lost response / retry on a slow network
//    or a quick re-login in the same 30s step never produces a false 401.
//  * Idempotent retry: repeating the request that already succeeded (flow is already
//    'ready'/'backup_codes') returns the same success, for both TOTP and backup codes.
//  * Backup codes are single-use; `remaining` is exact and does not depend on how a
//    data-modifying CTE snapshot is visible.
//  * Wrong codes: 3rd unlocks recovery, 5th kills the flow (trusted devices). A new,
//    unrecognised browser is device-blocked on the 3rd failure (device-failures.ts).
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { totpMatch, decryptSecret, sha256, toHex } from "./crypto";
import { emailTag } from "./keys";
import { reserve, noteFuse, refund, clearKeys } from "./throttle";
import { AuthRejectError, AuthLockedError, AuthRecoverableError, AuthServerFaultError } from "./errors";
import { loadFlow, type FlowRow, type VerifySecrets, type Stage } from "./flows";
import { normalizeBackupCode, normalizeTotpCode } from "./totp";
import {
  CODE_VERIFY_THRESHOLD,
  CODE_VERIFY_DECAY_SECS,
  TOTP_FAILS_TO_UNLOCK_RECOVERY,
  TOTP_MAX_FAILS_PER_FLOW,
} from "./config";
import { recordDeviceFailure } from "./device-failures";
import { swallow, swallowNull } from "../shared/logger";

function totpKey(tag: string, ip: string): string {
  return `totp:${tag}:${ip}`;
}

export interface TotpVerify { next: Stage; remaining: number | null; usedBackup: boolean; }

type Secrets = VerifySecrets & { totpEncKey: Uint8Array };

interface UserFactor { enc: string | null; active: boolean; enroll_open: boolean }

const loadUserFactor = (db: Db, userId: string) =>
  q1<UserFactor>(db,
    sql`SELECT totp_secret_enc AS enc, (totp_enabled_at IS NOT NULL) AS active,
            COALESCE(enroll_window_until > now(), false) AS enroll_open
      FROM aa_users WHERE id = ${userId}::uuid`);

/** Unused codes left in the user's current (acked, unrevoked) generation, EXCLUDING one hash. */
const remainingExcluding = (userId: string, hashHex: string) => sql`(
  SELECT count(*) FROM aa_backup_codes bc2
    JOIN aa_backup_code_sets s3 ON s3.id = bc2.set_id
   WHERE s3.user_id = ${userId}::uuid
     AND s3.acked_at IS NOT NULL AND s3.revoked_at IS NULL
     AND bc2.used_at IS NULL
     AND bc2.code_hash <> decode(${hashHex}, 'hex'))::int`;

/**
 * Idempotent retry of a request that ALREADY succeeded on this very flow (the flow has
 * since moved to 'ready'/'backup_codes'). Returns the same result, or null when the
 * submitted factor is not the one this flow consumed.
 */
async function resumeConsumed(
  db: Db, secrets: Secrets, flow: FlowRow, input: { code?: string; backupCode?: string },
  allowBackup: boolean, nowMs: number,
): Promise<TotpVerify | null> {
  if (flow.user_id === null) return null;
  if (input.backupCode !== undefined) {
    if (!allowBackup) return null;
    const hashHex = toHex(await sha256(normalizeBackupCode(input.backupCode)));
    const row = await q1<{ remaining: number }>(db,
      sql`SELECT ${remainingExcluding(flow.user_id, "00")} AS remaining
           WHERE EXISTS (SELECT 1 FROM aa_backup_codes bc
                          WHERE bc.used_flow_id = ${flow.id}::uuid
                            AND bc.code_hash = decode(${hashHex}, 'hex'))`);
    return row ? { next: flow.stage, remaining: row.remaining, usedBackup: true } : null;
  }
  const u = await q1<{ enc: string | null; last: string | null; last_flow: string | null }>(db,
    sql`SELECT totp_secret_enc AS enc, totp_last_step::text AS last, totp_last_flow::text AS last_flow
          FROM aa_users WHERE id = ${flow.user_id}::uuid`);
  if (!u?.enc || u.last === null || u.last_flow !== flow.id) return null;
  const secret = await decryptSecret(secrets.totpEncKey, u.enc).catch(swallowNull("totp_verify_lookup_failed"));
  if (!secret) return null;
  const step = await totpMatch(secret, normalizeTotpCode(input.code ?? ""), nowMs);
  return step !== null && String(step) === u.last
    ? { next: flow.stage, remaining: null, usedBackup: false } : null;
}

/**
 * POST /auth/totp {code} or {backup_code} at stage 'totp'.
 * allowBackup=false on the strict device path (spec §5.3 effect 2).
 * Backup use: single-use, atomic, returns remaining count (spec §5.6).
 */
export async function verifyTotp(
  db: Db, secrets: Secrets,
  flowToken: string, input: { code?: string; backupCode?: string },
  ip: string, allowBackup: boolean, nowMs = Date.now(),
): Promise<TotpVerify> {
  const flow = await loadFlow(db, flowToken);
  if (!flow || flow.user_id === null) throw new AuthRejectError("flow");
  if (flow.stage !== "totp") {
    if (flow.stage === "ready" || flow.stage === "backup_codes") {
      const again = await resumeConsumed(db, secrets, flow, input, allowBackup, nowMs).catch(swallowNull("totp_verify_lookup_failed"));
      if (again) return again;
    }
    throw new AuthRejectError("flow");
  }
  const userId = flow.user_id;
  const tag = await emailTag(secrets.throttleKey, flow.email);
  const key = totpKey(tag, ip);
  // Latency: the user-row read is independent of the throttle reservation, so they
  // run in parallel (one network round trip saved on every login).
  const urowP = input.backupCode === undefined ? loadUserFactor(db, userId) : null;
  urowP?.catch(() => { /* surfaced where awaited; avoids an unhandled rejection if reserve throws first */ });
  let reservation;
  try {
    // The per-flow counter (unlock@3, dead@5) is the authoritative limit for THIS
    // login; the throttle is a coarser per-IP backstop (spec §4.4b).
    reservation = await reserve(db, key, "anon", CODE_VERIFY_THRESHOLD, CODE_VERIFY_DECAY_SECS);
  } catch (e) {
    if (e instanceof AuthLockedError) await noteFuse(db, tag).catch(swallow("totp_verify_best_effort_failed"));
    throw e;
  }
  try {
    if (input.backupCode !== undefined) {
      if (!allowBackup) throw new AuthRejectError("backup");
      const hashHex = toHex(await sha256(normalizeBackupCode(input.backupCode)));
      // Consume one code from the ACKED, UNREVOKED generation and advance with the
      // same completion CASE as the authenticator path, in ONE statement.
      const row = await q1<{ stage: Stage; remaining: number }>(db,
        sql`WITH r AS (
           UPDATE aa_backup_codes bc SET used_at = now(), used_flow_id = ${flow.id}::uuid
            FROM aa_backup_code_sets s
           WHERE bc.set_id = s.id AND s.user_id = ${userId}::uuid
             AND s.acked_at IS NOT NULL AND s.revoked_at IS NULL
             AND bc.code_hash = decode(${hashHex}, 'hex')
             AND bc.used_at IS NULL
             AND EXISTS (SELECT 1 FROM aa_auth_flows
               WHERE id = ${flow.id}::uuid AND user_id = ${userId}::uuid
                 AND stage = 'totp' AND expires_at > now())
           RETURNING bc.set_id),
          adv AS (
           UPDATE aa_auth_flows f
              SET stage = CASE
                WHEN EXISTS (SELECT 1 FROM aa_backup_code_sets s2
                  WHERE s2.user_id = u.id AND s2.acked_at IS NULL AND s2.revoked_at IS NULL)
                  THEN 'backup_codes'
                ELSE 'ready' END,
                  last_step_at = now(), totp_fails = 0
             FROM aa_users u
            WHERE f.id = ${flow.id}::uuid AND f.stage = 'totp'
              AND f.expires_at > now() AND u.id = f.user_id AND u.is_active
              AND EXISTS (SELECT 1 FROM r) -- advance ONLY when a code was consumed
           RETURNING f.stage)
          SELECT (SELECT stage FROM adv) AS stage,
                 ${remainingExcluding(userId, hashHex)} AS remaining
           WHERE EXISTS (SELECT 1 FROM adv)`);
      if (!row) {
        // A concurrent duplicate of the SAME request may have just consumed it on this
        // flow: that is a success, not a wrong code.
        const flowNow = await loadFlow(db, flowToken);
        if (flowNow && (flowNow.stage === "ready" || flowNow.stage === "backup_codes")) {
          const again = await resumeConsumed(db, secrets, flowNow, input, allowBackup, nowMs).catch(swallowNull("totp_verify_lookup_failed"));
          if (again) { await clearKeys(db, [key]); return again; }
        }
        await noteFuse(db, tag).catch(swallow("totp_verify_best_effort_failed"));
        await recordDeviceFailure(db, secrets.throttleKey, flow.id, ip).catch(swallow("totp_verify_best_effort_failed"));
        throw new AuthRejectError("backup");
      }
      await clearKeys(db, [key]);
      return { next: row.stage, remaining: row.remaining, usedBackup: true };
    }

    const urow = await urowP!;
    if (!urow?.enc || !urow.active) {
      await noteFuse(db, tag).catch(swallow("totp_verify_best_effort_failed"));
      // No TOTP enrolled but the enroll window is still open: advance the flow
      // to totp_enroll so the operator can set up their authenticator instead of
      // hitting a dead-end "Invalid or expired code".
      if (urow?.enroll_open) {
        await refund(db, reservation).catch(swallow("totp_verify_best_effort_failed"));
        await clearKeys(db, [key]).catch(swallow("totp_verify_best_effort_failed"));
        await q1(db,
          sql`UPDATE aa_auth_flows SET stage = 'totp_enroll'
              WHERE id = ${flow.id}::uuid AND stage = 'totp' AND expires_at > now()`);
        return { next: "totp_enroll", remaining: null, usedBackup: false };
      }
      throw new AuthRejectError("totp");
    }
    const secret = await decryptSecret(secrets.totpEncKey, urow.enc).catch(swallowNull("totp_verify_lookup_failed"));
    if (!secret) {
      await refund(db, reservation).catch(swallow("totp_verify_best_effort_failed"));
      throw new AuthServerFaultError("totp decrypt");
    }
    const step = await totpMatch(secret, normalizeTotpCode(input.code ?? ""), nowMs);
    if (step === null) {
      // Wrong code: bump this flow's fail counter in ONE guarded statement. 3rd
      // fail unlocks recovery; 5th kills the flow. Run alongside noteFuse (independent).
      const [fail] = await Promise.all([
        q1<{ recovery_unlocked: boolean; stage: string }>(db,
          sql`UPDATE aa_auth_flows
                 SET totp_fails = totp_fails + 1,
                     recovery_unlocked = (totp_fails + 1 >= ${TOTP_FAILS_TO_UNLOCK_RECOVERY}),
                     stage = CASE WHEN totp_fails + 1 >= ${TOTP_MAX_FAILS_PER_FLOW} THEN 'dead' ELSE stage END
               WHERE id = ${flow.id}::uuid AND stage = 'totp' AND expires_at > now()
               RETURNING recovery_unlocked, stage`),
        noteFuse(db, tag).catch(swallow("totp_verify_best_effort_failed")),
      ]);
      // A new/unrecognised browser is device-blocked on the 3rd failure (the flow is
      // killed there): answer neutrally — recovery is NOT offered to a blocked device.
      const dev = await recordDeviceFailure(db, secrets.throttleKey, flow.id, ip, false)
        .catch(() => ({ failures: 0, blocked: false }));
      if (dev.blocked) throw new AuthRejectError("totp");
      if (fail?.recovery_unlocked) throw new AuthRecoverableError("totp");
      throw new AuthRejectError("totp");
    }

    // Success: consume the step AND advance the flow in ONE atomic statement
    // (completion CASE: unacked backup generation -> backup_codes, otherwise ready).
    // The step is consumable when it is newer than the last one used, or equal to it
    // AND repeated by the same flow / same browser (idempotent retry).
    const vid = flow.vid_hash;
    const adv = await q1<{ stage: Stage | null }>(db,
      sql`WITH consumed AS (
         UPDATE aa_users
            SET totp_last_step = ${step}::bigint,
                totp_last_vid = decode(${vid}::text, 'hex'),
                totp_last_flow = ${flow.id}::uuid
          WHERE id = ${userId}::uuid AND is_active
            AND (totp_last_step IS NULL OR totp_last_step < ${step}::bigint
                 OR (totp_last_step = ${step}::bigint
                     AND (totp_last_flow = ${flow.id}::uuid
                          OR (totp_last_vid IS NOT NULL
                              AND totp_last_vid = decode(${vid}::text, 'hex')))))
            AND EXISTS (SELECT 1 FROM aa_auth_flows ff
                         WHERE ff.id = ${flow.id}::uuid AND ff.stage = 'totp' AND ff.expires_at > now())
         RETURNING id),
        adv AS (
         UPDATE aa_auth_flows f
            SET stage = CASE
              WHEN EXISTS (SELECT 1 FROM aa_backup_code_sets s
                WHERE s.user_id = u.id AND s.acked_at IS NULL AND s.revoked_at IS NULL)
              THEN 'backup_codes'
              ELSE 'ready' END,
                last_step_at = now(), totp_fails = 0
           FROM aa_users u
          WHERE f.id = ${flow.id}::uuid AND f.stage = 'totp'
            AND f.expires_at > now() AND u.id = f.user_id AND u.is_active
            AND EXISTS (SELECT 1 FROM consumed)
         RETURNING f.stage)
        SELECT (SELECT stage FROM adv) AS stage`);
    if (!adv?.stage) {
      // Not consumed. Classify (rare path): concurrent duplicate of this very request,
      // a replay from another browser, or a flow that expired/died meanwhile.
      const st = await q1<{ stage: Stage; last: string | null; last_flow: string | null }>(db,
        sql`SELECT f.stage, u.totp_last_step::text AS last, u.totp_last_flow::text AS last_flow
              FROM aa_auth_flows f JOIN aa_users u ON u.id = f.user_id
             WHERE f.id = ${flow.id}::uuid AND f.expires_at > now()`);
      if (st && (st.stage === "ready" || st.stage === "backup_codes")
          && st.last_flow === flow.id && st.last === String(step)) {
        await clearKeys(db, [key]);
        return { next: st.stage, remaining: null, usedBackup: false };
      }
      if (st && st.stage === "totp") {
        // Replay of an already-used step from a different browser/flow: rejected,
        // and NOT counted against the recovery counters (spec §4.3).
        throw new AuthRejectError("totp replay");
      }
      await noteFuse(db, tag).catch(swallow("totp_verify_best_effort_failed"));
      throw new AuthRejectError("totp");
    }
    await clearKeys(db, [key]);
    return { next: adv.stage, remaining: null, usedBackup: false };
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError || e instanceof AuthRecoverableError) throw e;
    await refund(db, reservation).catch(swallow("totp_verify_best_effort_failed"));
    throw new AuthServerFaultError(e);
  }
}
