// Slice 7: block-on-3rd-wrong-backup-code wiring + entry enforcement (live DB).
// 3 wrong recovery codes kill the flow AND create a device block (on the
// flow's __Host-vid, until lifted) plus a 24 h ip block (the network). Entry
// (requestCode) then answers the identical dummy-flow 202 for that vid/IP;
// a different network still works; lifting the blocks restores access.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver, createDb, type Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, q1, sql } from "./sql";
import { recoverWithBackup } from "./recovery";
import { requestCode, type EntrySecrets } from "./entry";
import { liftBlock, vidHashHex } from "./blocks";
import { loadKey, randomToken } from "./crypto";
import { tokenHashHex } from "./keys";

const databaseUrl = process.env.DATABASE_URL;
registerDbDriver(pgDriver);
const db: Db = databaseUrl ? createDb(databaseUrl) : (null as unknown as Db);
const tag = `blk-${Date.now().toString(36)}`;
const secrets: EntrySecrets = {
  otpKey: loadKey("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "otp"),
  throttleKey: loadKey("CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", "throttle"),
};

after(async () => {
  if (!databaseUrl) return;
  await q(db, sql`SET aa.maint='on'`);
  await q(db, sql`DELETE FROM aa_auth_log WHERE user_id IN
    (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_blocks WHERE user_id IN
    (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_auth_flows WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await closePools();
});

test("3rd wrong backup code blocks the vid + ip; entry refuses; lift restores", { skip: !databaseUrl }, async () => {
  const email = `${tag}-u@example.com`;
  const ins = await q1<{ id: string }>(db,
    sql`INSERT INTO aa_users (email, role, totp_enabled_at, enroll_window_until)
         VALUES (${email}, 'staff', now(), now() + interval '72 hours')
         RETURNING id::text AS id`);
  const userId = ins!.id;
  const vid = randomToken();
  const vidH = await vidHashHex(secrets.throttleKey, vid);
  const IP = "10.82.8.2";
  const flowToken = `flow-${tag}`;
  const fh = await tokenHashHex(flowToken);
  const flowId = (await q1<{ id: string }>(db,
    sql`INSERT INTO aa_auth_flows (token_hash, email, user_id, stage, recovery_unlocked, vid_hash, expires_at)
         VALUES (decode(${fh}, 'hex'), ${email}, ${userId}, 'totp', true,
           decode(${vidH}, 'hex'), now() + interval '15 min')
         RETURNING id::text AS id`))!.id;

  // 2 wrong: rejected, nothing blocked yet.
  let r = await recoverWithBackup(db, secrets, flowToken, "totally-wrong-code", IP);
  assert.ok(!("next" in r) && r.attemptsLeft === 2);
  assert.equal((await q(db, sql`SELECT 1 FROM aa_blocks WHERE user_id = ${userId}::uuid`)).length, 0);
  r = await recoverWithBackup(db, secrets, flowToken, "still-wrong-code!!", IP);
  assert.ok(!("next" in r) && r.attemptsLeft === 1);
  assert.equal((await q(db, sql`SELECT 1 FROM aa_blocks WHERE user_id = ${userId}::uuid`)).length, 0);
  // 3rd wrong: flow dead AND blocks created.
  r = await recoverWithBackup(db, secrets, flowToken, "third-wrong-code!!!", IP);
  assert.ok(!("next" in r) && r.blocked === true, `expected blocked, got ${JSON.stringify(r)}`);

  // The 3rd wrong created an ip block (24 h TTL) + a device block (until lifted).
  const blocks = await q<{ kind: string; expires_at: Date | null; reason: string }>(db,
    sql`SELECT kind, expires_at, reason FROM aa_blocks
         WHERE user_id = ${userId}::uuid AND lifted_at IS NULL ORDER BY kind`);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "device", "device block has no expiry (admin lifts)");
  assert.equal(blocks[0].expires_at, null);
  assert.equal(blocks[1].kind, "ip", "ip block is time-boxed");
  assert.ok(blocks[1].expires_at !== null);
  assert.equal(blocks[0].reason, `recovery_fails:${flowId}`);
  // Alert queued (idempotent per flow).
  const outbox = await q(db,
    sql`SELECT 1 FROM aa_alert_outbox WHERE dedupe_key = ${`recovery_block:${flowId}`}`);
  assert.equal(outbox.length, 1);

  // Entry from the blocked vid/IP: identical dummy 202 — no email, no user.
  const A = { ip: IP, prefix: "10.82.8", country: "NG", ua: "itest" };
  const blockedOut = await requestCode(db, secrets, email, A, null, vid);
  assert.ok(blockedOut.flowToken.length > 20);
  assert.equal(blockedOut.sendCode, null, "no code for a blocked client");
  assert.equal(blockedOut.sendDeniedAlert, null);
  const bfHash = await tokenHashHex(blockedOut.flowToken);
  const blockedFlow = await q1<{ user_id: string | null }>(db,
    sql`SELECT user_id::text AS user_id FROM aa_auth_flows
         WHERE token_hash = decode(${bfHash}, 'hex')`);
  assert.equal(blockedFlow?.user_id, null, "blocked entry produces a dummy flow");

  // Same network, no vid: still blocked (the ip block is the backstop).
  const blockedNoVid = await requestCode(db, secrets, email, A, null, null);
  assert.equal(blockedNoVid.sendCode, null);

  // A different network (no vid) is unaffected: real path with a code.
  const B = { ip: "10.82.9.9", prefix: "10.82.9", country: "NG", ua: "itest" };
  const okOut = await requestCode(db, secrets, email, B, null, null);
  assert.ok(okOut.sendCode, "block is scoped to the vid/network, not the account");

  // Lifting both blocks restores the original client: the request takes the
  // REAL path again (user_id set on the flow; the email itself may be on the
  // resend cooldown, so we assert the path, not a fresh send).
  const live = await q<{ id: string; kind: string }>(db,
    sql`SELECT id::text AS id, kind FROM aa_blocks WHERE user_id = ${userId}::uuid AND lifted_at IS NULL`);
  for (const b of live) assert.equal(await liftBlock(db, b.id, userId), true);
  const restored = await requestCode(db, secrets, email, A, null, vid);
  const rh = await tokenHashHex(restored.flowToken);
  const restoredFlow = await q1<{ user_id: string | null }>(db,
    sql`SELECT user_id::text AS user_id FROM aa_auth_flows
         WHERE token_hash = decode(${rh}, 'hex')`);
  assert.equal(restoredFlow?.user_id, userId, "after the lift the same client gets a real flow");
});