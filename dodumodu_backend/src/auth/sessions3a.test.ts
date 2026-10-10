// Sessions part 2a: device path + strict tier + phrase/totp on device flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, q1, sql } from "./sql";
import { requestCode, type EntrySecrets } from "./entry";
import { verifyCode } from "./factors";
import { enrollPhrase, verifyPhrase } from "./phrase";
import { totpEnrollStart, totpEnrollConfirm } from "./totp";
import { verifyTotp } from "./totp-verify";
import { tierFor } from "./sessions";
import { finishAdminSession } from "./sessions-admin";
import { lookupSession } from "./session-lookup";
import { deviceStart } from "./devices";
import { loadKey, normalizeEmail, hotp, decryptSecret } from "./crypto";
import { AuthRejectError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
const tag = `sess2a:${Date.now().toString(36)}`;
const PHRASE = "correct horse 99!";
const A = { ip: "10.92.1.1", prefix: "10.92.1", country: "NG", ua: "itest" };
const B = { ip: "10.99.9.9", prefix: "10.99.9", country: "NG", ua: "itest" };

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
  await q(db, sql`DELETE FROM aa_recovery_codes WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_admin_devices WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE '%'`);
}

/** Full email-path admin first login to ready, then finish. Returns the device token. */
async function firstLogin(db: Db, s: ReturnType<typeof secrets>, email: string) {
  const r = await requestCode(db, s, email, A, null);
  assert.ok(r.sendCode);
  await verifyCode(db, s, r.flowToken, r.sendCode.code, A.ip);
  await enrollPhrase(db, s, r.flowToken, PHRASE, PHRASE, A.ip);
  const st = await totpEnrollStart(db, s, r.flowToken, email);
  const stepN = Math.floor(Date.now() / 30000);
  await totpEnrollConfirm(db, s, r.flowToken, await hotp(st.secret, stepN), A.ip);
  const fin = await finishAdminSession(db, { flowToken: r.flowToken, ...A, tier: "normal" });
  assert.ok(fin.deviceToken);
  return fin.deviceToken!;
}

test("sessions part 2a: device path + strict tier + phrase/totp on device flow", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });
  const s = secrets();
  const email = normalizeEmail(`${tag}-admin@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, device_window_until)
    VALUES (${email}, 'admin', now() + interval '72 hours')`);
  const deviceToken = await firstLogin(db, s, email);

  assert.equal(tierFor("10.92.1", "NG", "10.92.1", "NG", true), "normal");
  assert.equal(tierFor("10.92.1", "NG", "10.99.9", "NG", true), "strict");
  assert.equal(tierFor("10.92.1", "NG", "10.92.1", "GH", true), "strict");
  assert.equal(tierFor(null, null, "10.92.1", "NG", true), "normal");
  assert.equal(tierFor("10.92.1", "NG", "10.99.9", "NG", false), "normal");

  const d1 = await deviceStart(db, s.throttleKey, email, deviceToken, A.ip, A.prefix, A.country, A.ua);
  assert.equal(d1.real, true);
  assert.equal(d1.tier, "normal");
  const d2 = await deviceStart(db, s.throttleKey, email, deviceToken, B.ip, B.prefix, B.country, B.ua);
  assert.equal(d2.real, true);
  assert.equal(d2.tier, "strict");
  const d3 = await deviceStart(db, s.throttleKey, email, "bogus-device-token", A.ip, A.prefix, A.country, A.ua);
  assert.equal(d3.real, false);
  await assert.rejects(verifyPhrase(db, s, d3.flowToken, PHRASE, A.ip), AuthRejectError);

  // Strict device flow completes with phrase + authenticator -> strict session.
  const vp = await verifyPhrase(db, s, d2.flowToken, PHRASE, B.ip);
  assert.equal(vp.next, "totp");
  const nowMs = Date.now() + 120_000;
  const stepN = Math.floor(nowMs / 30000);
  const secRow = await q1<{ e: string }>(db,
    sql`SELECT totp_secret_enc AS e FROM aa_users WHERE email = ${email}`);
  const secret = await decryptSecret(s.totpEncKey, secRow!.e);
  const tv = await verifyTotp(db, s, d2.flowToken, { code: await hotp(secret, stepN) }, B.ip, false, nowMs);
  assert.equal(tv.next, "ready");
  const fin = await finishAdminSession(db, { flowToken: d2.flowToken, ...B, tier: "strict" });
  const sess = await lookupSession(db, fin.sessionToken);
  assert.ok(sess);
  assert.equal(sess.tier, "strict");
});
