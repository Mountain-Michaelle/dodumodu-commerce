// Factors integration tests: full staff journey + reject paths (v2 realigned).
// request -> code -> totp_enroll -> confirm (-> backup_codes) -> ack ->
// ready; a returning user goes code -> totp -> ready. Unknown flow -> 401;
// replay -> 401; wrong code -> 401; wrong stage -> 401; dummy rejects identically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { requestCode, type EntrySecrets } from "./entry";
import { verifyCode } from "./factors";
import { totpEnrollStart, totpEnrollConfirm, ackBackupCodes } from "./totp";
import { verifyTotp } from "./totp-verify";
import { loadKey, normalizeEmail, hotp } from "./crypto";
import { AuthRejectError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
const tag = `factors-${Date.now().toString(36)}`;
const CTX = { ip: "10.1.2.3", prefix: "10.1.2", country: "NG", ua: "itest" };

function secrets(): EntrySecrets & { totpEncKey: Uint8Array } {
  return {
    otpKey: loadKey("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "otp"),
    throttleKey: loadKey("CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", "throttle"),
    totpEncKey: loadKey("DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=", "totp-enc"),
  };
}

async function cleanup(db: Db) {
  await q(db, sql`DELETE FROM aa_auth_flows WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_login_challenges WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE '%'`);
}

test("factors: staff first login otp->totp_enroll->enroll_phrase->backup_codes->ack->ready", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });
  const s = secrets();
  const email = normalizeEmail(`${tag}-staff@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, enroll_window_until)
    VALUES (${email}, 'staff', now() + interval '72 hours')`);

  const req = await requestCode(db, s, email, CTX, null);
  assert.ok(req.sendCode);
  const code = req.sendCode.code;

  // Wrong code first: same neutral 401.
  await assert.rejects(verifyCode(db, s, req.flowToken, "FFFFFFFFFF", CTX.ip), AuthRejectError);
  // Right code: a new user with an open window goes to totp_enroll (TOTP first).
  const v = await verifyCode(db, s, req.flowToken, code, CTX.ip);
  assert.equal(v.next, "totp_enroll");
  // Replay of the same code: consumed -> 401 (flow already left otp anyway).
  await assert.rejects(verifyCode(db, s, req.flowToken, code, CTX.ip), AuthRejectError);

  // Enroll TOTP: wrong confirm code -> 401, then the current step -> backup_codes.
  const start = await totpEnrollStart(db, s, req.flowToken, email);
  await assert.rejects(totpEnrollConfirm(db, s, req.flowToken, "000000", CTX.ip), AuthRejectError);
  const step = Math.floor(Date.now() / 30000);
  const conf = await totpEnrollConfirm(db, s, req.flowToken, await hotp(start.secret, step), CTX.ip);
  assert.equal(conf.next, "backup_codes");
  assert.equal(conf.backupCodes.length, 8, "8 backup codes shown once at confirm");
  assert.ok(conf.backupCodes.every((c: string) => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(c)));

  // A session is impossible before the ack; ack -> ready; double ack -> 401.
  const a = await ackBackupCodes(db, req.flowToken);
  assert.equal(a.next, "ready");
  await assert.rejects(ackBackupCodes(db, req.flowToken), AuthRejectError);

  // Returning user: code -> totp (enrolled now), authenticator -> ready.
  const ip2 = "10.9.9.9";
  const req2 = await requestCode(db, s, email, { ...CTX, ip: ip2 }, null);
  assert.ok(req2.sendCode);
  const v2 = await verifyCode(db, s, req2.flowToken, req2.sendCode.code, ip2);
  assert.equal(v2.next, "totp");
  const nowMs = Date.now() + 90_000;
  const ok = await verifyTotp(db, s, req2.flowToken,
    { code: await hotp(start.secret, Math.floor(nowMs / 30000)) }, ip2, true, nowMs);
  assert.equal(ok.next, "ready");

  // Dummy flow (unknown email): rejects identically.
  const unk = await requestCode(db, s, `${tag}-ghost@example.com`, CTX, null);
  assert.equal(unk.sendCode, null);
  await assert.rejects(verifyCode(db, s, unk.flowToken, "AAAAAAAAAA", CTX.ip), AuthRejectError);

  // Unknown flow token: 401.
  await assert.rejects(verifyCode(db, s, "not-a-real-token", "AAAAAAAAAA", CTX.ip), AuthRejectError);
});
