// TOTP recovery thresholds (spec §4.3) for a TRUSTED browser: the 3rd wrong code
// unlocks recovery (AuthRecoverableError -> recovery_available:true), the 5th kills
// the flow. A replayed/already-used step from another browser is rejected WITHOUT
// burning an attempt; the same browser repeating it is let through (no false 401).
// A NEW browser is stricter: its 3rd failure device-blocks it (device-trust.test.ts).
// Live DB; fails fast (never skips) and refuses non-local databases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { q, q1, sql } from "./sql";
import { verifyTotp } from "./totp-verify";
import { recoverWithBackup } from "./recovery";
import { AuthRejectError, AuthRecoverableError } from "./errors";
import { sha256, toHex } from "./crypto";
import {
  openTestDb, closePools, testSecrets, makeTag, freshCtx, newVid, cleanupTag,
  createEnrolledUser, newTotpFlow, flowState, activeBlocks, codeFor, stepNow,
} from "./mfa-test-kit";

const db = openTestDb();
const secrets = testSecrets();
const tag = makeTag("rec");

after(async () => { await cleanupTag(db, tag); await closePools(); });

test("3rd wrong TOTP unlocks recovery; 5th kills the flow; replay is not counted", async () => {
  const u = await createEnrolledUser(db, secrets, `${tag}-u@example.com`, { lastStep: 0 });
  const f = await newTotpFlow(db, secrets, u, { vid: newVid(), trusted: true });
  const IP = freshCtx().ip;

  // 1st + 2nd wrong -> plain reject, not unlocked.
  await assert.rejects(() => verifyTotp(db, secrets, f.token, { code: "000000" }, IP, true), AuthRejectError);
  await assert.rejects(() => verifyTotp(db, secrets, f.token, { code: "000000" }, IP, true), AuthRejectError);
  let s = await flowState(db, f.id);
  assert.equal(s.totp_fails, 2);
  assert.equal(s.recovery_unlocked, false);

  // 3rd wrong -> recovery unlocked (AuthRecoverableError); a TRUSTED browser is not blocked.
  await assert.rejects(() => verifyTotp(db, secrets, f.token, { code: "000000" }, IP, true), AuthRecoverableError);
  s = await flowState(db, f.id);
  assert.equal(s.totp_fails, 3);
  assert.equal(s.recovery_unlocked, true);
  assert.equal(s.stage, "totp");
  assert.equal((await activeBlocks(db, f.id)).length, 0, "trusted browser is never device-blocked");

  // 4th + 5th wrong -> 5th kills the flow.
  await assert.rejects(() => verifyTotp(db, secrets, f.token, { code: "000000" }, IP, true), AuthRecoverableError);
  await assert.rejects(() => verifyTotp(db, secrets, f.token, { code: "000000" }, IP, true), AuthRecoverableError);
  s = await flowState(db, f.id);
  assert.equal(s.totp_fails, 5);
  assert.equal(s.stage, "dead");

  // A dead flow rejects any further attempt, even with the right code.
  const rightCode = await codeFor(u.secret, stepNow());
  await assert.rejects(() => verifyTotp(db, secrets, f.token, { code: rightCode }, IP, true), AuthRejectError);
});

test("a replayed TOTP step: other browser rejected without burning an attempt; same browser tolerated", async () => {
  const nowMs = 1_700_000_000_000;
  const step = stepNow(nowMs);
  const u = await createEnrolledUser(db, secrets, `${tag}-replay@example.com`, { lastStep: step - 1 });
  const vidA = newVid();
  const flowA = await newTotpFlow(db, secrets, u, { vid: vidA, trusted: true });
  const valid = await codeFor(u.secret, step);
  const IP = freshCtx().ip;

  const ok = await verifyTotp(db, secrets, flowA.token, { code: valid }, IP, true, nowMs);
  assert.equal(ok.next, "ready");

  // A DIFFERENT browser presenting the already-used code: rejected, attempt NOT burned, no block.
  const flowB = await newTotpFlow(db, secrets, u, { vid: newVid(), trusted: true });
  await assert.rejects(
    () => verifyTotp(db, secrets, flowB.token, { code: valid }, IP, true, nowMs), AuthRejectError);
  const sB = await flowState(db, flowB.id);
  assert.equal(sB.totp_fails, 0, "replay did not burn an attempt");
  assert.equal(sB.stage, "totp", "replay did not kill the flow");
  assert.equal(sB.recovery_unlocked, false);

  // The SAME browser (same __Host-vid) re-logging in within the step is let through.
  const flowA2 = await newTotpFlow(db, secrets, u, { vid: vidA, trusted: true });
  const again = await verifyTotp(db, secrets, flowA2.token, { code: valid }, IP, true, nowMs);
  assert.equal(again.next, "ready");
  assert.equal((await flowState(db, flowA2.id)).totp_fails, 0);
});

test("recovery backup code resets TOTP inside the flow (no session); wrong counts down; 3rd blocks", async () => {
  const CODE = "ABCDEFGH12"; // recovery input; stored as sha256(normalized)
  const codeHashHex = toHex(await sha256(CODE));
  const u = await createEnrolledUser(db, secrets, `${tag}-rec@example.com`, { nCodes: 0, lastStep: 0 });
  await q(db, sql`INSERT INTO aa_backup_codes (set_id, code_hash)
    SELECT id, decode(${codeHashHex}, 'hex') FROM aa_backup_code_sets WHERE user_id = ${u.id}::uuid`);
  const vid = newVid();
  const f = await newTotpFlow(db, secrets, u, { vid, trusted: true });
  await q(db, sql`UPDATE aa_auth_flows SET recovery_unlocked = true WHERE id = ${f.id}::uuid`);
  const IP = freshCtx().ip;

  // Recovery is gated: without recovery_unlocked it is a neutral reject.
  const locked = await newTotpFlow(db, secrets, u, { vid, trusted: true });
  await assert.rejects(() => recoverWithBackup(db, secrets, locked.token, CODE, IP), AuthRejectError);

  // Wrong code -> attempts_left counts down (2 then 1).
  let r = await recoverWithBackup(db, secrets, f.token, "totally-wrong-code", IP);
  assert.ok(!("next" in r) && r.attemptsLeft === 2, `expected 2 left, got ${JSON.stringify(r)}`);
  r = await recoverWithBackup(db, secrets, f.token, "still-wrong-code!!", IP);
  assert.ok(!("next" in r) && r.attemptsLeft === 1, `expected 1 left, got ${JSON.stringify(r)}`);

  // Correct code -> flow moves to totp_enroll in recovery_reset mode; no session.
  const ok = await recoverWithBackup(db, secrets, f.token, CODE, IP);
  assert.ok("next" in ok && ok.next === "totp_enroll", `expected totp_enroll, got ${JSON.stringify(ok)}`);
  const st = (await q1<{ stage: string; enroll_mode: string | null }>(db,
    sql`SELECT stage, enroll_mode FROM aa_auth_flows WHERE id = ${f.id}::uuid`))!;
  assert.equal(st.stage, "totp_enroll");
  assert.equal(st.enroll_mode, "recovery_reset");
});
