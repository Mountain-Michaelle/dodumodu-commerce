// Recovery (spec §4.4). Reachable ONLY after the flow passed OTP and hit 3 TOTP
// fails (recovery_unlocked, set by totp-verify). The secret phrase or a backup
// code does NOT log the user in — it resets TOTP INSIDE the flow: the flow moves
// to totp_enroll in 'recovery_reset' mode, so the user proves a NEW authenticator
// before any session exists. No restricted recovery session; admin device rules
// still apply at /auth/session (no bypass).
//
// Wrong phrase/backup: phrase_fails+1 (guarded). The 3rd wrong kills the flow
// AND creates the layered blocks (Slice 7): a device block on the flow's
// __Host-vid (until an admin lifts) plus a time-boxed ip block on the network
// (/32 v4, /64 v6), so a new flow from the same client is refused at entry.
// Counters are per-flow and never reset by a new flow.
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { randomToken, sha256, toHex } from "./crypto";
import { verifyPhrase as argonVerify } from "./argon2";
import { emailTag } from "./keys";
import { reserve, noteFuse, clearKeys } from "./throttle";
import { AuthRejectError, AuthLockedError, AuthServerFaultError } from "./errors";
import { loadFlow, type VerifySecrets, type Stage } from "./flows";
import { PHRASE_MAX_ATTEMPTS, BLOCK_IP_TTL_HOURS } from "./config";
import { writeAuthLog } from "./authLog";
import { createBlock, ipBlockHashHex } from "./blocks";
import { enqueue } from "./outbox";

export interface Guarded {
  ok: boolean;
  next?: Stage;
  attemptsLeft?: number;
  blocked?: boolean;
}

/** Load the flow and enforce: stage 'totp', recovery_unlocked, not expired. */
async function loadRecoverable(db: Db, flowToken: string) {
  const flow = await loadFlow(db, flowToken);
  if (!flow || flow.stage !== "totp" || flow.user_id === null) {
    throw new AuthRejectError("flow");
  }
  const row = await q1<{ recovery_unlocked: boolean; email: string }>(db,
    sql`SELECT recovery_unlocked, email FROM aa_auth_flows WHERE id = ${flow.id}`);
  if (!row?.recovery_unlocked) throw new AuthRejectError("flow"); // not unlocked -> neutral
  return { flowId: flow.id, userId: flow.user_id, email: row.email };
}

/** On a wrong phrase/backup: bump phrase_fails; 3rd -> flow dead. Returns state. */
async function registerWrongPhrase(db: Db, flowId: string): Promise<Guarded> {
  const row = await q1<{ phrase_fails: number }>(db,
    sql`UPDATE aa_auth_flows
           SET phrase_fails = phrase_fails + 1,
               stage = CASE WHEN phrase_fails + 1 >= ${PHRASE_MAX_ATTEMPTS} THEN 'dead' ELSE stage END
         WHERE id = ${flowId} AND stage = 'totp'
         RETURNING phrase_fails`);
  if (!row) return { ok: false };
  const blocked = row.phrase_fails >= PHRASE_MAX_ATTEMPTS;
  return { ok: false, attemptsLeft: Math.max(0, PHRASE_MAX_ATTEMPTS - row.phrase_fails), blocked };
}

/**
 * Slice 7 wiring, called once when the flow dies on the 3rd wrong phrase:
 * a 'device' block on the flow's vid_hash (until an admin lifts) and an 'ip'
 * block on the network (BLOCK_IP_TTL_HOURS, so a shared NAT recovers on its
 * own). Both carry the flow's user + a random appeal handle; the alert goes
 * through the outbox (deduped per flow). Best-effort AFTER the flow is dead:
 * a block-write failure never changes the response the attacker already got.
 */
async function blockOnPhraseFails(
  db: Db, throttleKey: Uint8Array, flowId: string, userId: string, ip: string,
): Promise<void> {
  try {
    const f = await q1<{ vid_hash: string | null }>(db,
      sql`SELECT encode(vid_hash, 'hex') AS vid_hash FROM aa_auth_flows WHERE id = ${flowId}`);
    const ref = randomToken();
    await createBlock(db, {
      kind: "ip", keyHashHex: await ipBlockHashHex(throttleKey, ip), blockRef: ref,
      userId, reason: `phrase_fails:${flowId}`,
      expiresAt: new Date(Date.now() + BLOCK_IP_TTL_HOURS * 3600_000),
    });
    if (f?.vid_hash) {
      await createBlock(db, {
        kind: "device", keyHashHex: f.vid_hash, blockRef: randomToken(),
        userId, reason: `phrase_fails:${flowId}`, // NULL expires: admin lifts
      });
    }
    await enqueue(db, "phrase_block", `phrase_block:${flowId}`);
    await writeAuthLog(db, {
      event: "phrase_blocked", status: "blocked", userId, flowId, reason: "recovery",
      meta: { ip_block_ref: ref },
    });
  } catch {
    /* the flow is already dead; a block-write failure must not surface */
  }
}

/** On success: move the flow to totp_enroll in recovery_reset mode. */
async function advanceToReset(db: Db, flowId: string, userId: string, via: string): Promise<Stage> {
  const row = await q1<{ stage: Stage }>(db,
    sql`UPDATE aa_auth_flows
           SET stage = 'totp_enroll', enroll_mode = 'recovery_reset',
               totp_fails = 0, recovery_unlocked = false
         WHERE id = ${flowId} AND stage = 'totp'
         RETURNING stage`);
  if (!row) throw new AuthRejectError("flow");
  // Kill every existing session (the authenticator is being replaced) + audit.
  await q(db, sql`UPDATE aa_users SET session_version = session_version + 1 WHERE id = ${userId}`);
  await writeAuthLog(db, { event: "recovery_login_used", status: "success", userId, reason: via }).catch(() => {});
  return row.stage;
}

/** POST /auth/recovery/phrase {phrase}. Gated by recovery_unlocked. */
export async function recoverWithPhrase(
  db: Db, secrets: VerifySecrets, flowToken: string, phrase: string, ip: string,
): Promise<{ next: Stage } | Guarded> {
  const { flowId, userId, email } = await loadRecoverable(db, flowToken);
  const tag = await emailTag(secrets.throttleKey, email);
  const key = `phrase:${tag}:${ip}`;
  const reservation = await reserve(db, key, "anon", PHRASE_MAX_ATTEMPTS + 1);
  try {
    const urow = await q1<{ phrase_hash: string | null; is_active: boolean }>(db,
      sql`SELECT phrase_hash, is_active FROM aa_users WHERE id = ${userId}`);
    const ok = urow?.is_active && urow.phrase_hash !== null &&
      await argonVerify(urow.phrase_hash, phrase).catch(() => false);
    if (!ok) {
      const wrong = await registerWrongPhrase(db, flowId);
      await noteFuse(db, tag).catch(() => {});
      await writeAuthLog(db, {
        event: "phrase_fail", status: wrong.blocked ? "blocked" : "fail",
        userId, reason: "recovery",
      }).catch(() => {});
      if (wrong.blocked) await blockOnPhraseFails(db, secrets.throttleKey, flowId, userId, ip);
      return wrong;
    }
    await clearKeys(db, [key]);
    return { next: await advanceToReset(db, flowId, userId, "phrase") };
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) throw e;
    await noteFuse(db, tag).catch(() => {});
    throw new AuthServerFaultError(e);
  } finally {
    void reservation;
  }
}

/** POST /auth/recovery/backup-code {code}. Same gate + counters as the phrase. */
export async function recoverWithBackup(
  db: Db, secrets: VerifySecrets, flowToken: string, code: string, ip: string,
): Promise<{ next: Stage } | Guarded> {
  const { flowId, userId, email } = await loadRecoverable(db, flowToken);
  const tag = await emailTag(secrets.throttleKey, email);
  const key = `phrase:${tag}:${ip}`;
  const reservation = await reserve(db, key, "anon", PHRASE_MAX_ATTEMPTS + 1);
  try {
    const norm = code.replace(/-/g, "");
    const hashHex = toHex(await sha256(norm));
    // Consume one code from the current acknowledged, unrevoked generation.
    const used = await q1<{ set_id: string }>(db,
      sql`UPDATE aa_backup_codes bc SET used_at = now()
            FROM aa_backup_code_sets s
           WHERE bc.set_id = s.id AND s.user_id = ${userId}
             AND s.acked_at IS NOT NULL AND s.revoked_at IS NULL
             AND bc.code_hash = decode(${hashHex}, 'hex') AND bc.used_at IS NULL
           RETURNING bc.set_id::text AS set_id`);
    if (!used) {
      const wrong = await registerWrongPhrase(db, flowId);
      await noteFuse(db, tag).catch(() => {});
      await writeAuthLog(db, {
        event: "backup_code_fail", status: wrong.blocked ? "blocked" : "fail",
        userId, reason: "recovery",
      }).catch(() => {});
      if (wrong.blocked) await blockOnPhraseFails(db, secrets.throttleKey, flowId, userId, ip);
      return wrong;
    }
    await clearKeys(db, [key]);
    return { next: await advanceToReset(db, flowId, userId, "backup") };
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) throw e;
    await noteFuse(db, tag).catch(() => {});
    throw new AuthServerFaultError(e);
  } finally {
    void reservation;
  }
}

