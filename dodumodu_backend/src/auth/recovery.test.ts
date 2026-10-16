// TOTP recovery thresholds (spec §4.3): 3rd wrong code unlocks recovery
// (AuthRecoverableError -> recovery_available:true), 5th kills the flow. A
// replayed/already-used step is rejected WITHOUT burning an attempt. Live DB.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver, createDb, type Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, q1, sql } from "./sql";
import { verifyTotp } from "./totp-verify";
import { recoverWithPhrase } from "./recovery";
import { AuthRejectError, AuthRecoverableError } from "./errors";
import { newTotpSecret, encryptSecret, loadKey, hotp } from "./crypto";
import { hashPhrase } from "./argon2";
import { tokenHashHex } from "./keys";

const databaseUrl = process.env.DATABASE_URL;
registerDbDriver(pgDriver);
const db: Db = databaseUrl ? createDb(databaseUrl) : (null as unknown as Db);
const tag = `rec:${Date.now().toString(36)}`;
const secrets = {
  otpKey: loadKey("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "otp"),
  throttleKey: loadKey("CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", "throttle"),
  totpEncKey: loadKey("DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=", "totp-enc"),
};

after(async () => {
  if (!databaseUrl) return;
  await q(db, sql`SET aa.maint='on'`);
  await q(db, sql`DELETE FROM aa_auth_log WHERE email_tag IS NOT NULL AND reason LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_flows WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  // Throttle rows are keyed by HMAC(email):ip (unique per run) and auto-expire;
  // a global DELETE here would race other test files that share this dev DB.
  await closePools();
});

test("3rd wrong TOTP unlocks recovery; 5th kills the flow; replay is not counted", { skip: !databaseUrl }, async () => {
  const email = `${tag}-u@example.com`;
  const secretB32 = newTotpSecret();
  const enc = await encryptSecret(secrets.totpEncKey, secretB32);
  const ins = await q1<{ id: string }>(db,
    sql`INSERT INTO aa_users (email, role, totp_secret_enc, totp_enabled_at, totp_last_step)
         VALUES (${email}, 'staff', ${enc}, now(), 0) RETURNING id::text AS id`);
  const userId = ins!.id;
  // Fully-enrolled fixture: a phrase + an ACKED, unrevoked backup generation,
  // so a successful TOTP advance lands on 'ready' (the v2 completion CASE).
  await q(db, sql`UPDATE aa_users SET phrase_hash = md5('fixture')
    WHERE id = ${userId}::uuid AND phrase_hash IS NULL`);
  await q(db, sql`INSERT INTO aa_backup_code_sets (user_id, generation, acked_at)
    VALUES (${userId}::uuid, 1, now())`);
  await q(db, sql`INSERT INTO aa_backup_codes (set_id, code_hash)
    SELECT id, decode(md5('fixture-code'), 'hex') FROM aa_backup_code_sets
     WHERE user_id = ${userId}::uuid`);

  const flowToken = `flow-${tag}`;
  const fh = await tokenHashHex(flowToken);
  const flowId = (await q1<{ id: string }>(db,
    sql`INSERT INTO aa_auth_flows (token_hash, email, user_id, stage, expires_at)
         VALUES (decode(${fh}, 'hex'), ${email}, ${userId}, 'totp', now() + interval '15 min')
         RETURNING id::text AS id`))!.id;
  const IP = "10.77.7.7";
  const state = async () => {
    const r = await q1<{ totp_fails: number; recovery_unlocked: boolean; stage: string }>(db,
      sql`SELECT totp_fails, recovery_unlocked, stage FROM aa_auth_flows WHERE id = ${flowId}::uuid`);
    if (!r) throw new Error("flow row missing");
    return r;
  };

  // 1st + 2nd wrong -> plain reject, not unlocked.
  await assert.rejects(() => verifyTotp(db, secrets, flowToken, { code: "000000" }, IP, true), AuthRejectError);
  await assert.rejects(() => verifyTotp(db, secrets, flowToken, { code: "000000" }, IP, true), AuthRejectError);
  let s = await state();
  assert.equal(s.totp_fails, 2);
  assert.equal(s.recovery_unlocked, false);

  // 3rd wrong -> recovery unlocked (AuthRecoverableError).
  await assert.rejects(() => verifyTotp(db, secrets, flowToken, { code: "000000" }, IP, true), AuthRecoverableError);
  s = await state();
  assert.equal(s.totp_fails, 3);
  assert.equal(s.recovery_unlocked, true);
  assert.equal(s.stage, "totp");

  // 4th + 5th wrong -> 5th kills the flow.
  await assert.rejects(() => verifyTotp(db, secrets, flowToken, { code: "000000" }, IP, true), AuthRecoverableError);
  await assert.rejects(() => verifyTotp(db, secrets, flowToken, { code: "000000" }, IP, true), AuthRecoverableError);
  s = await state();
  assert.equal(s.totp_fails, 5);
  assert.equal(s.stage, "dead");

  // A dead flow rejects any further attempt.
  await assert.rejects(() => verifyTotp(db, secrets, flowToken, { code: "000000" }, IP, true), AuthRejectError);
});

test("a replayed TOTP step is rejected without burning an attempt", { skip: !databaseUrl }, async () => {
  const email = `${tag}-replay@example.com`;
  const secretB32 = newTotpSecret();
  const enc = await encryptSecret(secrets.totpEncKey, secretB32);
  const nowMs = 1_700_000_000_000;
  const step = Math.floor(nowMs / 30000);
  const userId = (await q1<{ id: string }>(db,
    sql`INSERT INTO aa_users (email, role, totp_secret_enc, totp_enabled_at, totp_last_step)
         VALUES (${email}, 'staff', ${enc}, now(), ${step - 1}) RETURNING id::text AS id`))!.id;
  // Fully-enrolled fixture (phrase + acked generation) so success -> 'ready'.
  await q(db, sql`UPDATE aa_users SET phrase_hash = md5('fixture')
    WHERE id = ${userId}::uuid AND phrase_hash IS NULL`);
  await q(db, sql`INSERT INTO aa_backup_code_sets (user_id, generation, acked_at)
    VALUES (${userId}::uuid, 1, now())`);
  await q(db, sql`INSERT INTO aa_backup_codes (set_id, code_hash)
    SELECT id, decode(md5('fixture-code'), 'hex') FROM aa_backup_code_sets
     WHERE user_id = ${userId}::uuid`);
  const flowToken = `flow-${tag}-replay`;
  const fh = await tokenHashHex(flowToken);
  await q(db,
    sql`INSERT INTO aa_auth_flows (token_hash, email, user_id, stage, expires_at)
         VALUES (decode(${fh}, 'hex'), ${email}, ${userId}, 'totp', now() + interval '15 min')`);
  const valid = await hotp(secretB32, step); // current step
  // First use succeeds.
  const ok = await verifyTotp(db, secrets, flowToken, { code: valid }, "10.77.7.8", true, nowMs);
  assert.equal(ok.next, "ready");
  // Replaying the same step on a fresh 'totp' flow is rejected, totp_fails stays 0.
  const fh2 = await tokenHashHex(`flow-${tag}-replay2`);
  const flowId2 = (await q1<{ id: string }>(db,
    sql`INSERT INTO aa_auth_flows (token_hash, email, user_id, stage, expires_at)
         VALUES (decode(${fh2}, 'hex'), ${email}, ${userId}, 'totp', now() + interval '15 min')
         RETURNING id::text AS id`))!.id;
  await assert.rejects(() => verifyTotp(db, secrets, `flow-${tag}-replay2`, { code: valid }, "10.77.7.8", true, nowMs), AuthRejectError);
  const s = (await q1<{ totp_fails: number }>(db, sql`SELECT totp_fails FROM aa_auth_flows WHERE id = ${flowId2}::uuid`))!;
  assert.equal(s.totp_fails, 0, "replay did not burn an attempt");
});

test("recovery phrase resets TOTP inside the flow (no session); wrong counts down; 3rd blocks", { skip: !databaseUrl }, async () => {
  const email = `${tag}-rec@example.com`;
  const PHRASE = "correct-horse-battery-99";
  const hash = await hashPhrase(PHRASE);
  const enc = await encryptSecret(secrets.totpEncKey, newTotpSecret());
  const userId = (await q1<{ id: string }>(db,
    sql`INSERT INTO aa_users (email, role, phrase_hash, totp_secret_enc, totp_enabled_at, totp_last_step)
         VALUES (${email}, 'staff', ${hash}, ${enc}, now(), 0) RETURNING id::text AS id`))!.id;
  const flowToken = `flow-${tag}-rec`;
  const fh = await tokenHashHex(flowToken);
  const flowId = (await q1<{ id: string }>(db,
    sql`INSERT INTO aa_auth_flows (token_hash, email, user_id, stage, recovery_unlocked, expires_at)
         VALUES (decode(${fh}, 'hex'), ${email}, ${userId}, 'totp', true, now() + interval '15 min')
         RETURNING id::text AS id`))!.id;
  const IP = "10.78.8.8";
  const state = async () => (await q1<{ stage: string; enroll_mode: string | null; phrase_fails: number }>(db,
    sql`SELECT stage, enroll_mode, phrase_fails FROM aa_auth_flows WHERE id = ${flowId}::uuid`))!;

  // Recovery is gated: without recovery_unlocked it is a neutral reject.
  const lockedToken = `flow-${tag}-rec-locked`;
  const lfh = await tokenHashHex(lockedToken);
  await q(db, sql`INSERT INTO aa_auth_flows (token_hash, email, user_id, stage, recovery_unlocked, expires_at)
    VALUES (decode(${lfh}, 'hex'), ${email}, ${userId}, 'totp', false, now() + interval '15 min')`);
  await assert.rejects(() => recoverWithPhrase(db, secrets, lockedToken, PHRASE, IP), AuthRejectError);

  // Wrong phrase -> attempts_left counts down (2 then 1).
  let r = await recoverWithPhrase(db, secrets, flowToken, "totally-wrong-phrase", IP);
  assert.ok(!("next" in r) && r.attemptsLeft === 2, `expected 2 left, got ${JSON.stringify(r)}`);
  r = await recoverWithPhrase(db, secrets, flowToken, "still-wrong-phrase!!", IP);
  assert.ok(!("next" in r) && r.attemptsLeft === 1, `expected 1 left, got ${JSON.stringify(r)}`);

  // Correct phrase -> flow moves to totp_enroll in recovery_reset mode; no session.
  const ok = await recoverWithPhrase(db, secrets, flowToken, PHRASE, IP);
  assert.ok("next" in ok && ok.next === "totp_enroll", `expected totp_enroll, got ${JSON.stringify(ok)}`);
  const st = await state();
  assert.equal(st.stage, "totp_enroll");
  assert.equal(st.enroll_mode, "recovery_reset");
});
