// TOTP backup codes integration tests — spec §5.6 (part 2, generations M6).
// Single-use against the ACKED, unrevoked generation, returns an exact `remaining`;
// reuse = 401; unknown = 401; strict device path refuses backup codes without
// consuming them. Independent of totp.test.ts (shared fixtures live in mfa-test-kit).
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
  openTestDb, closePools, testSecrets, makeTag, freshCtx, cleanupTag, loginToTotpStage,
} from "./mfa-test-kit";

const db = openTestDb();
const tag = makeTag("tbk");
after(async () => { await cleanupTag(db, tag); await closePools(); });

test("totp part 2: backup codes single-use, remaining, strict refusal", async () => {
  const s = testSecrets();
  const A = freshCtx(), B = freshCtx(), C = freshCtx();
  const email = normalizeEmail(`${tag}-admin2@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, device_window_until, enroll_window_until)
    VALUES (${email}, 'admin', now() + interval '72 hours', now() + interval '72 hours')`);

  // First login: otp -> totp_enroll -> confirm (issues backup codes) -> ack.
  const req = await requestCode(db, s, email, A, null);
  assert.ok(req.sendCode);
  await verifyCode(db, s, req.flowToken, req.sendCode.code, A.ip);
  const start = await totpEnrollStart(db, s, req.flowToken, email);
  const step = Math.floor(Date.now() / 30000);
  const conf = await totpEnrollConfirm(db, s, req.flowToken, await hotp(start.secret, step), A.ip);
  assert.equal(conf.next, "backup_codes");
  const enrolled = conf;
  assert.equal(enrolled.backupCodes.length, 8);
  // Consumption requires an ACKED generation: before the ack the codes do not work.
  const early = await requestCode(db, s, email, A, null);
  assert.ok(early.sendCode);
  await verifyCode(db, s, early.flowToken, early.sendCode.code, A.ip);
  await assert.rejects(verifyTotp(db, s, early.flowToken,
    { backupCode: enrolled.backupCodes[0] }, A.ip, true), AuthRejectError);
  await ackBackupCodes(db, req.flowToken);

  const f1 = await loginToTotpStage(db, s, email, A);
  const used = await verifyTotp(db, s, f1, { backupCode: enrolled.backupCodes[0] }, A.ip, true);
  assert.equal(used.next, "ready");
  assert.equal(used.usedBackup, true);
  assert.equal(used.remaining, 7, "remaining is exact: 8 codes, 1 consumed");

  const f2 = await loginToTotpStage(db, s, email, B);
  await assert.rejects(verifyTotp(db, s, f2,
    { backupCode: enrolled.backupCodes[0] }, B.ip, true), AuthRejectError);
  await assert.rejects(verifyTotp(db, s, f2,
    { backupCode: "AAAAA-AAAAA" }, B.ip, true), AuthRejectError);
  await assert.rejects(verifyTotp(db, s, f2,
    { backupCode: enrolled.backupCodes[1] }, B.ip, false), AuthRejectError);
  // The refused code was NOT consumed: usable on the normal path (fresh flow).
  const f3 = await loginToTotpStage(db, s, email, C);
  const ok2 = await verifyTotp(db, s, f3, { backupCode: enrolled.backupCodes[1] }, C.ip, true);
  assert.equal(ok2.next, "ready");
  assert.equal(ok2.remaining, 6);
});
