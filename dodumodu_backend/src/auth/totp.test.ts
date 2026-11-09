// TOTP + backup codes integration tests — spec §5.6 (realigned M2/M4/M6/M8).
// First login order: otp -> totp_enroll -> confirm (-> backup_codes) ->
// ack -> ready. Returning logins: otp -> totp -> ready. Part 1 (this file) covers
// enrolment + authenticator + step replay; part 2 (totp-backup.test.ts) covers backup
// codes; totp-relogin.test.ts covers repeated logins on bad networks.
// Fails fast (never skips) and refuses non-local databases (see mfa-test-kit.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { q, sql } from "./sql";
import { requestCode } from "./entry";
import { verifyCode } from "./factors";
import { totpEnrollStart, totpEnrollConfirm, ackBackupCodes } from "./totp";
import { verifyTotp } from "./totp-verify";
import { normalizeEmail, hotp } from "./crypto";
import { AuthRejectError } from "./errors";
import {
  openTestDb, closePools, testSecrets, makeTag, freshCtx, newVid, cleanupTag, loginToTotpStage,
} from "./mfa-test-kit";

const db = openTestDb();
const tag = makeTag("totp");
after(async () => { await cleanupTag(db, tag); await closePools(); });

test("totp part 1: first login TOTP->backup->ack, authenticator, step replay", async () => {
  const s = testSecrets();
  const email = normalizeEmail(`${tag}-admin@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, device_window_until, enroll_window_until)
    VALUES (${email}, 'admin', now() + interval '72 hours', now() + interval '72 hours')`);
  const CTX = freshCtx();

  const req = await requestCode(db, s, email, CTX, null);
  assert.ok(req.sendCode, "open window = real path with code");
  const v = await verifyCode(db, s, req.flowToken, req.sendCode.code, CTX.ip);
  assert.equal(v.next, "totp_enroll", "new user enrolls TOTP first");

  const start = await totpEnrollStart(db, s, req.flowToken, email);
  assert.equal(start.secret.length, 32);
  assert.ok(start.otpauthUri.startsWith("otpauth://totp/"));
  // Re-issue while the flow is alive REPLACES the unconfirmed secret (so a lost
  // response / reload during enrolment never dead-ends): the old QR stops working.
  const reissued = await totpEnrollStart(db, s, req.flowToken, email);
  assert.notEqual(reissued.secret, start.secret, "re-issue yields a fresh secret");

  await assert.rejects(
    totpEnrollConfirm(db, s, req.flowToken, "000000", CTX.ip), AuthRejectError);
  const step = Math.floor(Date.now() / 30000);
  await assert.rejects(
    totpEnrollConfirm(db, s, req.flowToken, await hotp(start.secret, step), CTX.ip),
    AuthRejectError, "the superseded secret no longer confirms");
  const good = await hotp(reissued.secret, step);
  const conf = await totpEnrollConfirm(db, s, req.flowToken, good, CTX.ip);
  assert.equal(conf.next, "backup_codes", "TOTP confirm hands over the backup codes");
  assert.equal(conf.backupCodes.length, 8);
  await assert.rejects(
    totpEnrollConfirm(db, s, req.flowToken, good, CTX.ip), AuthRejectError);

  const ack = await ackBackupCodes(db, req.flowToken);
  assert.equal(ack.next, "ready");

  // Returning user: code -> totp; authenticator step ahead of the confirm step.
  const browser1 = newVid();
  const C2 = freshCtx();
  const f2 = await loginToTotpStage(db, s, email, C2, { vid: browser1 });
  const fixedNow = Date.now() + 90_000; // 3 windows ahead: step > confirm step
  const fixedStep = Math.floor(fixedNow / 30000);
  const fixedCode = await hotp(reissued.secret, fixedStep);
  const ok = await verifyTotp(db, s, f2, { code: fixedCode }, C2.ip, true, fixedNow);
  assert.equal(ok.next, "ready");
  assert.equal(ok.usedBackup, false);

  // Replay of the SAME step from ANOTHER browser is rejected (and burns no attempt).
  const C3 = freshCtx();
  const f3 = await loginToTotpStage(db, s, email, C3, { vid: newVid() });
  await assert.rejects(
    verifyTotp(db, s, f3, { code: fixedCode }, C3.ip, true, fixedNow), AuthRejectError);

  // The SAME browser repeating it inside the step is tolerated: no false 401 on a
  // quick re-login / retry over a slow link.
  const C4 = freshCtx();
  const f4 = await loginToTotpStage(db, s, email, C4, { vid: browser1 });
  const same = await verifyTotp(db, s, f4, { code: fixedCode }, C4.ip, true, fixedNow);
  assert.equal(same.next, "ready");
  assert.equal(same.usedBackup, false);
});
