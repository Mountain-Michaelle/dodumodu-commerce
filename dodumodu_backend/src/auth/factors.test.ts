// Factors integration tests: full staff journey + reject paths.
// request -> code -> phrase -> ready; unknown flow -> 401; replay -> 401;
// wrong code -> 401; wrong stage -> 401; dummy flow rejects identically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { requestCode, type EntrySecrets } from "./entry";
import { verifyCode } from "./factors";
import { enrollPhrase, verifyPhrase } from "./phrase";
import { loadKey, normalizeEmail } from "./crypto";
import { AuthRejectError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
const tag = `factors:${Date.now().toString(36)}`;
const CTX = { ip: "10.1.2.3", prefix: "10.1.2", country: "NG", ua: "itest" };

function secrets(): EntrySecrets {
  return {
    otpKey: loadKey("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "otp"),
    throttleKey: loadKey("CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", "throttle"),
  };
}

async function cleanup(db: Db) {
  await q(db, sql`DELETE FROM aa_auth_flows WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_login_challenges WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE '%'`);
}

test("factors: staff full journey request->code->phrase->ready", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });
  const s = secrets();
  const email = normalizeEmail(`${tag}-staff@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role) VALUES (${email}, 'staff')`);

  const req = await requestCode(db, s, email, CTX, null);
  assert.ok(req.sendCode);
  const code = req.sendCode.code;

  // Wrong code first: same neutral 401.
  await assert.rejects(verifyCode(db, s, req.flowToken, "FFFFFFFFFF", CTX.ip), AuthRejectError);
  // Right code: advances to enroll_phrase (no phrase yet).
  const v = await verifyCode(db, s, req.flowToken, code, CTX.ip);
  assert.equal(v.next, "enroll_phrase");
  // Replay of the same code: consumed -> 401 (flow already left otp anyway).
  await assert.rejects(verifyCode(db, s, req.flowToken, code, CTX.ip), AuthRejectError);

  // Mismatched confirm: 401.
  await assert.rejects(
    enrollPhrase(db, s, req.flowToken, "correct horse 99!", "different phrase 99!", CTX.ip),
    AuthRejectError);
  // Enroll: staff -> ready.
  const e = await enrollPhrase(db, s, req.flowToken, "correct horse 99!", "correct horse 99!", CTX.ip);
  assert.equal(e.next, "ready");
  // Double enroll: stage is ready now -> 401.
  await assert.rejects(
    enrollPhrase(db, s, req.flowToken, "another phrase 00!", "another phrase 00!", CTX.ip),
    AuthRejectError);

  // New flow for the same staff user: code -> phrase stage (phrase exists now).
  const req2 = await requestCode(db, s, email, { ...CTX, ip: "10.9.9.9" }, null);
  assert.ok(req2.sendCode);
  const v2 = await verifyCode(db, s, req2.flowToken, req2.sendCode.code, "10.9.9.9");
  assert.equal(v2.next, "phrase");
  // Wrong phrase: 401.
  await assert.rejects(verifyPhrase(db, s, req2.flowToken, "wrong phrase at all", "10.9.9.9"), AuthRejectError);
  // Right phrase: staff -> ready.
  const p = await verifyPhrase(db, s, req2.flowToken, "correct horse 99!", "10.9.9.9");
  assert.equal(p.next, "ready");

  // Dummy flow (unknown email): rejects identically at code and phrase.
  const unk = await requestCode(db, s, `${tag}-ghost@example.com`, CTX, null);
  assert.equal(unk.sendCode, null);
  await assert.rejects(verifyCode(db, s, unk.flowToken, "AAAAAAAAAA", CTX.ip), AuthRejectError);
  await assert.rejects(verifyPhrase(db, s, unk.flowToken, "anything at all here", CTX.ip), AuthRejectError);

  // Unknown flow token: 401.
  await assert.rejects(verifyCode(db, s, "not-a-real-token", "AAAAAAAAAA", CTX.ip), AuthRejectError);
});
