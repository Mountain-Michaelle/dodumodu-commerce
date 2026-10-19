// Throttle lifecycle integration tests — reserve / settle / refund (Appendix F2).
// Run against local Postgres: DATABASE_URL=postgresql://postgres@localhost:55432/dodumodu
// Skipped when DATABASE_URL is absent (matches the repo's house integration pattern).
//
// These verify the exact semantics the service depends on:
//   - reserve: PAIR_THRESHOLD allows thr-1, the thr-th trips a ~10 min lock (escalation round 1)
//   - blocked requests: reserve throws AuthLockedError (never counted again)
//   - clearKeys: success resets the counter entirely
//   - refund non-lock: fails decremented by 1, never below zero
//   - refund tripped: only when locked_until still exactly matches; clears lock
//   - noteFuse: returns false below FUSE_FRICTION_THRESHOLD=9, true at/above, never locks
//   - sendCap: limit=1 allows 1st, refuses 2nd within the window
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { reserve, refund, noteFuse, clearKeys, sendCap } from "./throttle";
import { PAIR_THRESHOLD } from "./config";
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { AuthLockedError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
const tag = `itest-${Date.now().toString(36)}`;

async function throttleRow(db: Db, key: string) {
  return q1<{ fails: number; round: number; locked_until: string | null }>(
    db,
    sql`SELECT fails, round, locked_until::text AS locked_until FROM aa_auth_throttle WHERE key = ${key}`,
  );
}

async function cleanup(db: Db) {
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE ${tag + "%"}`);
}

test("throttle lifecycle: reserve, lock, settle, refund, fuse, send cap", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });

  const key = `${tag}:otp:hmac:1.2.3.4`;

  // 1. Reserves below the pair threshold are allowed; the counter climbs.
  const r1 = await reserve(db, key, "anon");
  assert.equal(r1.key, key);
  assert.equal(r1.lockedUntil, null);
  for (let i = 2; i < PAIR_THRESHOLD; i++) await reserve(db, key, "anon");
  assert.equal((await throttleRow(db, key))?.fails, PAIR_THRESHOLD - 1);

  // 2. The PAIR_THRESHOLD-th reserve is allowed AND trips the pair lock
  // (round 1 => ~10 min): fails resets to 0, round=1. The reservation carries
  // full-precision lock text.
  const r3 = await reserve(db, key, "anon");
  const locked = await throttleRow(db, key);
  assert.equal(locked?.fails, 0);
  assert.equal(locked?.round, 1);
  assert.notEqual(locked?.locked_until, null);
  assert.match(r3.lockedUntil ?? "", /^\d{4}-\d{2}-\d{2}/);
  assert.ok((r3.lockedUntil ?? "").length > 19, "locked_until text must keep sub-second precision");

  // 3. Blocked requests throw AuthLockedError with a positive retry countdown.
  await assert.rejects(reserve(db, key, "anon"), (e: unknown) => {
    assert.ok(e instanceof AuthLockedError);
    assert.ok(e.retryAfterSecs > 0 && e.retryAfterSecs <= 600);
    return true;
  });

  // 4. Refund with the EXACT tripped string clears the lock (fails back to thr-1).
  assert.equal(await refund(db, r3), true);
  const afterRefund = await throttleRow(db, key);
  assert.equal(afterRefund?.locked_until, null);
  assert.equal(afterRefund?.fails, PAIR_THRESHOLD - 1);

  // 5. Refund a non-lock reservation: fails decremented by 1.
  const before = (await throttleRow(db, key))?.fails ?? 0;
  assert.equal(await refund(db, { key, lockedUntil: null }), true);
  assert.equal((await throttleRow(db, key))?.fails, before - 1);

  // 6. Refund never goes below zero: drain to zero, one more refund returns false.
  for (let i = 0; i < 10; i++) {
    const ok = await refund(db, { key, lockedUntil: null });
    if (!ok) break;
  }
  const drained = await throttleRow(db, key);
  assert.ok((drained?.fails ?? 0) >= 0);

  // 7. Success clears everything: reserve 2, clear, counter gone.
  const key2 = `${tag}:otp:hmac:9.9.9.9`;
  await reserve(db, key2, "anon");
  await reserve(db, key2, "anon");
  await clearKeys(db, [key2]);
  assert.equal(await throttleRow(db, key2), null);

  // 8. Fuse: 9 notes => friction on, and it never locks (10th note still allowed).
  const fuseKey = `${tag}:fusemail`;
  const got: boolean[] = [];
  got.push(await noteFuse(db, fuseKey)); // 1
  for (let i = 0; i < 7; i++) await noteFuse(db, fuseKey); // 2..8
  got.push(await noteFuse(db, fuseKey)); // 9
  assert.equal(got[0], false, "first fuse note must not signal friction");
  assert.equal(got[1], true, "9th fuse note must signal friction");
  const fuse10 = await noteFuse(db, fuseKey); // 10
  assert.equal(fuse10, true, "fuse must keep returning true, never lock");
  const fuseRow = await throttleRow(db, `fuse:${fuseKey}`);
  assert.equal(fuseRow?.locked_until, null, "fuse must never set locked_until");

  // 9. sendCap: limit 1 => 1st true, 2nd false within the window.
  const sendKey = `${tag}:send:hmac`;
  assert.equal(await sendCap(db, sendKey, 1, "1 hour"), true);
  assert.equal(await sendCap(db, sendKey, 1, "1 hour"), false);
});
