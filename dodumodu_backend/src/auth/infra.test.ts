// Integration coverage for the Phase 3 security infra against a real Postgres
// (skipped when DATABASE_URL is unset, e.g. CI without a DB). Exercises the
// auth-log writer + its append-only trigger, blocks (create/expire/lift), and
// the idempotent outbox (enqueue/dedupe/claim/send). Local, disposable only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver, createDb, type Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { writeAuthLog } from "./authLog";
import { isBlocked, createBlock, liftBlock } from "./blocks";
import { enqueue, claimOutbox, markSent } from "./outbox";
import { dbErrorInfo } from "../shared/dbError";

const databaseUrl = process.env.DATABASE_URL;
registerDbDriver(pgDriver);
const db: Db = databaseUrl ? createDb(databaseUrl) : (null as unknown as Db);
const tag = `infra-${Date.now().toString(36)}`;
const kh = "ab".repeat(32); // 64-hex key hash

before(async () => { if (databaseUrl) await q(db, sql`SELECT 1`); });
after(async () => {
  if (!databaseUrl) return;
  // The append-only trigger blocks DELETE; retention/cleanup uses the aa_maint
  // escape hatch (the same path the retention job uses).
  await q(db, sql`WITH m AS (SELECT set_config('aa.maint', 'on', true)) DELETE FROM aa_auth_log WHERE EXISTS (SELECT 1 FROM m) AND reason LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_blocks WHERE block_ref LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_alert_outbox WHERE dedupe_key LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await closePools();
});

test("writeAuthLog inserts and returns an id; the row is append-only", { skip: !databaseUrl }, async () => {
  const id = await writeAuthLog(db, { event: "otp_requested", status: "info", reason: tag, ipHashHex: kh });
  assert.ok(id > 0);
  await assert.rejects(
    () => q(db, sql`UPDATE aa_auth_log SET reason='x' WHERE id=${id}`),
    (e: unknown) => /append-only/.test(dbErrorInfo(e).message),
  );
});

test("blocks: create -> active; expired -> inactive; lift -> inactive", { skip: !databaseUrl }, async () => {
  const ref = `${tag}-dev`;
  // Self-contained: create the lifter instead of assuming the DB already has a user
  // (a freshly migrated database has none, which made this test fail spuriously).
  const actor = (await q<{ id: string }>(db,
    sql`INSERT INTO aa_users (email, role) VALUES (${tag + "-lifter@example.com"}, 'admin')
        RETURNING id::text AS id`))[0];
  assert.ok(actor, "a user exists to act as the lifter");
  await createBlock(db, { kind: "device", keyHashHex: kh, blockRef: ref, reason: tag });
  const blk = await isBlocked(db, "device", kh);
  assert.ok(blk, "fresh device block is active");
  assert.equal(await liftBlock(db, blk.id, actor.id), true, "lift succeeds");
  assert.equal(await isBlocked(db, "device", kh), null, "lifted block is inactive");
});

test("blocks: an IP block already past expires_at is not active", { skip: !databaseUrl }, async () => {
  const ref = `${tag}-ip`;
  const past = new Date(Date.now() - 60_000);
  await createBlock(db, { kind: "ip", keyHashHex: kh, blockRef: ref, expiresAt: past });
  assert.equal(await isBlocked(db, "ip", kh), null, "expired IP block is inactive");
  await q(db, sql`DELETE FROM aa_blocks WHERE block_ref=${ref}`);
});

test("outbox: enqueue is idempotent; claim + send clears it", { skip: !databaseUrl }, async () => {
  const key = `${tag}-email`;
  const first = await enqueue(db, "phrase_block", key, null);
  assert.ok(first, "first enqueue inserts");
  const dup = await enqueue(db, "phrase_block", key, null);
  assert.equal(dup, null, "duplicate dedupe_key does not insert again");
  const claimed = await claimOutbox(db, 1000);
  assert.ok(claimed.some((r) => r.id === first), "the row is claimable");
  await markSent(db, first!);
  const again = await claimOutbox(db, 1000);
  assert.ok(!again.some((r) => r.id === first), "a sent row is not re-claimed");
});
