// Device trust policy (the contract these tests pin):
//   * The FIRST-CONFIGURED browser (active device cookie) is TRUSTED: default
//     throttling/rate limiting only — it is never device-blocked, recovery unlocks at
//     the 3rd wrong code and the flow dies at the 5th.
//   * ANY OTHER browser may still log in, but is STRICT: its 3rd failed attempt blocks
//     THAT BROWSER (device block on its __Host-vid), only an admin can lift it.
//   * The block is DEVICE-based: other browsers on the same IP and the trusted browser
//     keep working. Only a browser with no vid at all falls back to a time-boxed IP block.
// Live DB; fails fast (never skips) and refuses non-local databases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { q1, sql } from "./sql";
import { requestCode } from "./entry";
import { verifyCode } from "./factors";
import { verifyTotp } from "./totp-verify";
import { deviceStart } from "./devices";
import { liftBlock } from "./blocks";
import { AuthRejectError, AuthRecoverableError, AuthLockedError } from "./errors";
import { tokenHashHex } from "./keys";
import {
  openTestDb, closePools, testSecrets, makeTag, freshCtx, newVid, cleanupTag,
  createEnrolledUser, createActiveDevice, newTotpFlow, flowState, activeBlocks,
  codeFor, stepNow, loginToTotpStage,
} from "./mfa-test-kit";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("dtrust");
after(async () => { await cleanupTag(db, tag); await closePools(); });
const emailOf = (n: string) => `${tag}-${n}@example.com`;
const wrong = (token: string, ip: string, allowBackup = true) =>
  verifyTotp(db, s, token, { code: "000000" }, ip, allowBackup);

const flowOf = async (token: string) => (await q1<{ id: string; trusted: boolean; via: string }>(db,
  sql`SELECT id::text AS id, trusted, via FROM aa_auth_flows
       WHERE token_hash = decode(${await tokenHashHex(token)}, 'hex')`))!;

test("NEW browser: still allowed in, but its 3rd failure device-blocks it (device-based, admin-lift only)", async () => {
  const u = await createEnrolledUser(db, s, emailOf("new"), { role: "admin" });
  const vid = newVid(), ctx = freshCtx();
  const token = await loginToTotpStage(db, s, u.email, ctx, { vid });   // allowed in (email OTP ok)
  const f = await flowOf(token);
  assert.equal(f.trusted, false, "a browser with no device cookie is not trusted");

  await assert.rejects(wrong(token, ctx.ip), AuthRejectError);
  await assert.rejects(wrong(token, ctx.ip), AuthRejectError);
  assert.equal((await activeBlocks(db, f.id)).length, 0, "no block before the 3rd failure");
  // 3rd failure: neutral reject (NOT the recovery hint) and the flow is dead + blocked
  await assert.rejects(wrong(token, ctx.ip), (e) => e instanceof AuthRejectError && !(e instanceof AuthRecoverableError));
  assert.equal((await flowState(db, f.id)).stage, "dead");
  const blocks = await activeBlocks(db, f.id);
  assert.equal(blocks.length, 1, "exactly one block: the DEVICE — no ip block");
  assert.equal(blocks[0].kind, "device");
  assert.equal(blocks[0].expires_at, null, "no expiry: only an admin lifts it");
  // even the right code is useless now
  await assert.rejects(verifyTotp(db, s, token, { code: await codeFor(u.secret, stepNow()) }, ctx.ip, true), AuthRejectError);

  // The blocked browser gets the neutral dummy flow (no email) from ANY network...
  const blockedOut = await requestCode(db, s, u.email, freshCtx(), null, vid);
  assert.equal(blockedOut.sendCode, null);
  // ...while ANOTHER browser on the SAME IP is unaffected (block is not network-wide).
  const sameIpOther = await requestCode(db, s, u.email, ctx, null, newVid());
  assert.ok(sameIpOther.sendCode, "a different browser on the same IP still gets a real flow");

  // Only an admin lifting the block restores that browser.
  const blk = await q1<{ id: string }>(db, sql`SELECT id::text AS id FROM aa_blocks
    WHERE reason = ${"auth_failures:" + f.id} AND lifted_at IS NULL`);
  assert.equal(await liftBlock(db, blk!.id, u.id), true);
  const restored = await requestCode(db, s, u.email, freshCtx(), null, vid);
  assert.ok(restored.sendCode, "after the admin lifts it the browser gets a real flow again");
});

test("NEW browser: failures of any kind count — 3 wrong email codes block it too", async () => {
  const u = await createEnrolledUser(db, s, emailOf("otp"), { role: "admin" });
  const vid = newVid(), ctx = freshCtx();
  const req = await requestCode(db, s, u.email, ctx, null, vid);
  assert.ok(req.sendCode);
  const f = await flowOf(req.flowToken);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(verifyCode(db, s, req.flowToken, "000000", ctx.ip), AuthRejectError);
  }
  const blocks = await activeBlocks(db, f.id);
  assert.deepEqual(blocks.map((b) => b.kind), ["device"]);
});

test("NEW browser: 2 wrong TOTP + 1 wrong backup code also trips the block (shared counter)", async () => {
  const u = await createEnrolledUser(db, s, emailOf("mix"), { role: "admin" });
  const f = await newTotpFlow(db, s, u, { vid: newVid() });
  const ip = freshCtx().ip;
  await assert.rejects(wrong(f.token, ip), AuthRejectError);
  await assert.rejects(wrong(f.token, ip), AuthRejectError);
  await assert.rejects(verifyTotp(db, s, f.token, { backupCode: "ZZZZZ-ZZZZZ" }, ip, true), AuthRejectError);
  assert.deepEqual((await activeBlocks(db, f.id)).map((b) => b.kind), ["device"]);
  assert.equal((await flowState(db, f.id)).stage, "dead");
});

test("TRUSTED browser (device path): never blocked — recovery at 3, dead at 5", async () => {
  const u = await createEnrolledUser(db, s, emailOf("tdev"), { role: "admin" });
  const did = await createActiveDevice(db, u.id);
  const ctx = freshCtx();
  const out = await deviceStart(db, s.throttleKey, u.email, did, ctx.ip, ctx.prefix, ctx.country, "itest", newVid());
  assert.equal(out.real, true);
  const f = await flowOf(out.flowToken);
  assert.equal(f.via, "device");

  await assert.rejects(wrong(out.flowToken, ctx.ip, false), AuthRejectError);
  await assert.rejects(wrong(out.flowToken, ctx.ip, false), AuthRejectError);
  await assert.rejects(wrong(out.flowToken, ctx.ip, false), AuthRecoverableError);   // 3rd unlocks recovery
  assert.equal((await flowState(db, f.id)).recovery_unlocked, true);
  assert.equal((await flowState(db, f.id)).stage, "totp", "still alive after the 3rd failure");
  await assert.rejects(wrong(out.flowToken, ctx.ip, false), AuthRecoverableError);
  await assert.rejects(wrong(out.flowToken, ctx.ip, false), AuthRecoverableError);
  assert.equal((await flowState(db, f.id)).stage, "dead", "5th kills the flow");
  assert.equal((await activeBlocks(db, f.id)).length, 0, "a trusted device is never device-blocked");
});

test("TRUSTED browser (email path with the device cookie): flow is marked trusted and keeps default limits", async () => {
  const u = await createEnrolledUser(db, s, emailOf("tmail"), { role: "admin" });
  const did = await createActiveDevice(db, u.id);
  const vid = newVid(), ctx = freshCtx();

  // cookie matches an active device -> trusted
  const withCookie = await requestCode(db, s, u.email, ctx, did, vid);
  assert.ok(withCookie.sendCode);
  assert.equal((await flowOf(withCookie.flowToken)).trusted, true);
  // (one live email challenge per user: finish this login BEFORE requesting another code)
  const v = await verifyCode(db, s, withCookie.flowToken, withCookie.sendCode.code, ctx.ip);
  assert.equal(v.next, "totp");
  const f = await flowOf(withCookie.flowToken);
  for (let i = 0; i < 2; i++) await assert.rejects(wrong(withCookie.flowToken, ctx.ip), AuthRejectError);
  await assert.rejects(wrong(withCookie.flowToken, ctx.ip), AuthRecoverableError);
  assert.equal((await activeBlocks(db, f.id)).length, 0);
  assert.equal((await flowState(db, f.id)).stage, "totp");

  // forged cookie / no cookie -> NOT trusted
  const forged = await requestCode(db, s, u.email, freshCtx(), "did-forged", newVid());
  assert.equal((await flowOf(forged.flowToken)).trusted, false, "a forged cookie earns no trust");
  const none = await requestCode(db, s, u.email, freshCtx(), null, newVid());
  assert.equal((await flowOf(none.flowToken)).trusted, false);
});

test("a blocked NEW browser never blocks the account: the trusted browser still logs in end to end", async () => {
  const u = await createEnrolledUser(db, s, emailOf("scope"), { role: "admin" });
  const did = await createActiveDevice(db, u.id);
  const ctx = freshCtx();
  const badVid = newVid();
  const f = await newTotpFlow(db, s, u, { vid: badVid });
  for (let i = 0; i < 3; i++) await assert.rejects(wrong(f.token, ctx.ip), AuthRejectError);
  assert.equal((await activeBlocks(db, f.id)).length, 1);

  const good = await requestCode(db, s, u.email, ctx, did, newVid());       // same IP, trusted cookie
  assert.ok(good.sendCode, "trusted browser is not silenced by the new browser's block");
  await verifyCode(db, s, good.flowToken, good.sendCode.code, ctx.ip);
  const r = await verifyTotp(db, s, good.flowToken, { code: await codeFor(u.secret, stepNow()) }, ctx.ip, true);
  assert.equal(r.next, "ready");
});

test("cookie-less new browser (no vid): falls back to a TIME-BOXED ip block, never a device block", async () => {
  const u = await createEnrolledUser(db, s, emailOf("novid"), { role: "admin" });
  const f = await newTotpFlow(db, s, u, { vid: null });
  const ctx = freshCtx();
  for (let i = 0; i < 3; i++) await assert.rejects(wrong(f.token, ctx.ip), AuthRejectError);
  const blocks = await activeBlocks(db, f.id);
  assert.deepEqual(blocks.map((b) => b.kind), ["ip"]);
  assert.ok(blocks[0].expires_at !== null, "ip fallback is time-boxed");
  const blockedNet = await requestCode(db, s, u.email, ctx, null, null);
  assert.equal(blockedNet.sendCode, null);
  const otherNet = await requestCode(db, s, u.email, freshCtx(), null, null);
  assert.ok(otherNet.sendCode, "other networks are unaffected");
});

test("normal browsers keep the DEFAULT rate limit: a burst from one IP gets 429-style AuthLockedError, never a device block", async () => {
  const u = await createEnrolledUser(db, s, emailOf("rate"), { role: "admin" });
  const ip = freshCtx().ip;
  let locked = false;
  const seen: string[] = [];
  for (let i = 0; i < 16 && !locked; i++) {
    const f = await newTotpFlow(db, s, u, { vid: newVid() });          // 1 failure per flow: far below the device rule
    try { await wrong(f.token, ip); } catch (e) {
      if (e instanceof AuthLockedError) locked = true;
      else assert.ok(e instanceof AuthRejectError);
    }
    seen.push(f.id);
  }
  assert.ok(locked, "the per-IP throttle still trips on a fast burst");
  for (const id of seen) assert.equal((await activeBlocks(db, id)).length, 0);
});
