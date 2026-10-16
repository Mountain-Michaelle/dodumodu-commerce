// TOTP + backup codes integration tests — spec §5.6 (realigned M2/M4/M6/M8).
// First login order: otp -> totp_enroll -> enroll_phrase -> backup_codes ->
// ack -> ready. Returning logins: otp -> totp -> ready. Part 1 covers enroll +
// authenticator + step replay; part 2 (totp-backup.test.ts) covers backup codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { requestCode, type EntrySecrets } from "./entry";
import { verifyCode } from "./factors";
import { enrollPhrase } from "./phrase";
import { totpEnrollStart, totpEnrollConfirm, ackBackupCodes } from "./totp";
import { verifyTotp } from "./totp-verify";
import { loadKey, normalizeEmail, hotp } from "./crypto";
import { AuthRejectError } from "./errors";

export const tag = `totp-${Date.now().toString(36)}`;
export const CTX = { ip: "10.2.3.4", prefix: "10.2.3", country: "NG", ua: "itest" };
export const PHRASE = "correct-horse-99!";   // §5.2.1: no spaces

export function secrets(): EntrySecrets & { totpEncKey: Uint8Array } {
  return {
    otpKey: loadKey("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "otp"),
    throttleKey: loadKey("CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", "throttle"),
    totpEncKey: loadKey("DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=", "totp-enc"),
  };
}

export async function cleanup(db: Db) {
  await q(db, sql`DELETE FROM aa_auth_flows WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_login_challenges WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_backup_codes WHERE set_id IN
    (SELECT id FROM aa_backup_code_sets WHERE user_id IN
      (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"}))`);
  await q(db, sql`DELETE FROM aa_backup_code_sets WHERE user_id IN
    (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_recovery_codes WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE '%'`);
}

/** Fresh login advanced to stage 'totp' (or wherever verifyCode lands). */
export async function loginToTotp(db: Db, s: ReturnType<typeof secrets>, email: string, ip: string) {
  const req = await requestCode(db, s, email, { ...CTX, ip }, null);
  assert.ok(req.sendCode);
  const v = await verifyCode(db, s, req.flowToken, req.sendCode.code, ip);
  assert.equal(v.next, "totp");
  return req.flowToken;
}

const databaseUrl = process.env.DATABASE_URL;

test("totp part 1: first login TOTP->phrase->backup->ack, authenticator, step replay", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });
  const s = secrets();
  const email = normalizeEmail(`${tag}-admin@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, device_window_until, enroll_window_until)
    VALUES (${email}, 'admin', now() + interval '72 hours', now() + interval '72 hours')`);

  const req = await requestCode(db, s, email, CTX, null);
  assert.ok(req.sendCode, "open window = real path with code");
  const v = await verifyCode(db, s, req.flowToken, req.sendCode.code, CTX.ip);
  assert.equal(v.next, "totp_enroll", "new user enrolls TOTP first");

  const start = await totpEnrollStart(db, s, req.flowToken, email);
  assert.equal(start.secret.length, 32);
  assert.ok(start.otpauthUri.startsWith("otpauth://totp/"));
  await assert.rejects(totpEnrollStart(db, s, req.flowToken, email), AuthRejectError);

  await assert.rejects(
    totpEnrollConfirm(db, s, req.flowToken, "000000", CTX.ip), AuthRejectError);
  const step = Math.floor(Date.now() / 30000);
  const good = await hotp(start.secret, step);
  const conf = await totpEnrollConfirm(db, s, req.flowToken, good, CTX.ip);
  assert.equal(conf.next, "enroll_phrase", "TOTP first, then the phrase");
  assert.deepEqual(conf.backupCodes, [], "codes come only at the backup stage");
  await assert.rejects(
    totpEnrollConfirm(db, s, req.flowToken, good, CTX.ip), AuthRejectError);

  const e = await enrollPhrase(db, s, req.flowToken, PHRASE, PHRASE, CTX.ip);
  assert.equal(e.next, "backup_codes");
  assert.equal(e.backupCodes.length, 8);
  const ack = await ackBackupCodes(db, req.flowToken);
  assert.equal(ack.next, "ready");

  // Returning user: code -> totp; authenticator step ahead of the confirm step.
  const f2 = await loginToTotp(db, s, email, "10.5.5.5");
  const fixedNow = Date.now() + 90_000; // 3 windows ahead: step > confirm step
  const fixedStep = Math.floor(fixedNow / 30000);
  const fixedCode = await hotp(start.secret, fixedStep);
  const ok = await verifyTotp(db, s, f2, { code: fixedCode }, "10.5.5.5", true, fixedNow);
  assert.equal(ok.next, "ready");
  assert.equal(ok.usedBackup, false);

  // Same step, same nowMs, fresh flow: replay guard fires (deterministic).
  const f3 = await loginToTotp(db, s, email, "10.6.6.6");
  await assert.rejects(verifyTotp(db, s, f3,
    { code: fixedCode }, "10.6.6.6", true, fixedNow), AuthRejectError);
});