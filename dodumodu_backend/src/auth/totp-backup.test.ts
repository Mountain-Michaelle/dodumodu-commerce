// TOTP backup codes integration tests — spec §5.6 (part 2, generations M6).
// Single-use against the ACKED, unrevoked generation, returns remaining;
// reuse = 401; unknown = 401; strict device path refuses backup codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { requestCode } from "./entry";
import { verifyCode } from "./factors";
import { enrollPhrase } from "./phrase";
import { totpEnrollStart, totpEnrollConfirm, ackBackupCodes } from "./totp";
import { verifyTotp } from "./totp-verify";
import { normalizeEmail, hotp } from "./crypto";
import { AuthRejectError } from "./errors";
import { tag, PHRASE, secrets, cleanup } from "./totp.test";

const databaseUrl = process.env.DATABASE_URL;
const A = { ip: "10.77.7.7", prefix: "10.77.7", country: "NG", ua: "itest" };
const B = { ip: "10.77.8.8", prefix: "10.77.8", country: "NG", ua: "itest" };

test("totp part 2: backup codes single-use, remaining, strict refusal", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });
  const s = secrets();
  const email = normalizeEmail(`${tag}-admin2@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, device_window_until, enroll_window_until)
    VALUES (${email}, 'admin', now() + interval '72 hours', now() + interval '72 hours')`);

  // First login: otp -> totp_enroll -> confirm -> enroll_phrase -> backup -> ack.
  const req = await requestCode(db, s, email, A, null);
  assert.ok(req.sendCode);
  await verifyCode(db, s, req.flowToken, req.sendCode.code, A.ip);
  const start = await totpEnrollStart(db, s, req.flowToken, email);
  const step = Math.floor(Date.now() / 30000);
  const conf = await totpEnrollConfirm(db, s, req.flowToken, await hotp(start.secret, step), A.ip);
  assert.equal(conf.next, "enroll_phrase");
  const enrolled = await enrollPhrase(db, s, req.flowToken, PHRASE, PHRASE, A.ip);
  assert.equal(enrolled.next, "backup_codes");
  assert.equal(enrolled.backupCodes.length, 8);
  // Consumption requires an ACKED generation: before the ack the codes do not work.
  const early = await requestCode(db, s, email, A, null);
  assert.ok(early.sendCode);
  await verifyCode(db, s, early.flowToken, early.sendCode.code, A.ip);
  await assert.rejects(verifyTotp(db, s, early.flowToken,
    { backupCode: enrolled.backupCodes[0] }, A.ip, true), AuthRejectError);
  await ackBackupCodes(db, req.flowToken);

  async function freshTotpFlow(c: typeof A) {
    const r = await requestCode(db, s, email, c, null);
    assert.ok(r.sendCode);
    await verifyCode(db, s, r.flowToken, r.sendCode.code, c.ip);
    return r.flowToken;
  }

  const f1 = await freshTotpFlow(A);
  const used = await verifyTotp(db, s, f1, { backupCode: enrolled.backupCodes[0] }, A.ip, true);
  assert.equal(used.next, "ready");
  assert.equal(used.usedBackup, true);
  assert.equal(used.remaining, 7);

  const f2 = await freshTotpFlow(B);
  await assert.rejects(verifyTotp(db, s, f2,
    { backupCode: enrolled.backupCodes[0] }, B.ip, true), AuthRejectError);
  await assert.rejects(verifyTotp(db, s, f2,
    { backupCode: "AAAAA-AAAAA" }, B.ip, true), AuthRejectError);
  await assert.rejects(verifyTotp(db, s, f2,
    { backupCode: enrolled.backupCodes[1] }, B.ip, false), AuthRejectError);
  // The refused code was NOT consumed: usable on the normal path (fresh flow).
  const C = { ip: "10.77.9.9", prefix: "10.77.9", country: "NG", ua: "itest" };
  const f3 = await freshTotpFlow(C);
  const ok2 = await verifyTotp(db, s, f3, { backupCode: enrolled.backupCodes[1] }, C.ip, true);
  assert.equal(ok2.next, "ready");
  assert.equal(ok2.remaining, 6);
});