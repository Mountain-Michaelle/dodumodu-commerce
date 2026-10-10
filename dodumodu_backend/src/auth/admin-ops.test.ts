// Admin ops part 1: perms, create, guards, phrase reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { createUser, grantPerm, revokePerm, deactivateUser,
  createPhraseReset, consumePhraseReset } from "./admin-ops";
import { verifyPhrase } from "./argon2";
import { PERMISSIONS } from "./config";
import { AuthRejectError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
const tag = `ops:${Date.now().toString(36)}`;

async function cleanup(db: Db) {
  await q(db, sql`DELETE FROM aa_user_permissions WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_phrase_resets WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE '%'`);
}

test("admin ops part 1: perms, create, guards, phrase reset", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });

  const adminA = await createUser(db, `${tag}-a@example.com`, "admin", null as never);
  const adminB = await createUser(db, `${tag}-b@example.com`, "admin", adminA);
  const staff = await createUser(db, `${tag}-s@example.com`, "staff", adminA);

  await grantPerm(db, staff, PERMISSIONS.ordersView, adminA);
  const perms = await q<{ perm: string }>(db,
    sql`SELECT perm FROM aa_user_permissions WHERE user_id = ${staff}`);
  assert.deepEqual(perms.map((p) => p.perm), [PERMISSIONS.ordersView]);
  await revokePerm(db, staff, PERMISSIONS.ordersView);
  assert.equal((await q(db, sql`SELECT 1 FROM aa_user_permissions WHERE user_id = ${staff}`)).length, 0);
  await assert.rejects(grantPerm(db, staff, "not.a.perm", adminA), AuthRejectError);
  await assert.rejects(createUser(db, `${tag}-s@example.com`, "staff", adminA), AuthRejectError);

  // Last-admin guard.
  await deactivateUser(db, adminA);
  const remain = await q<{ id: string }>(db,
    sql`SELECT id FROM aa_users WHERE role = 'admin' AND is_active ORDER BY id`);
  assert.equal(remain.length, 1);
  assert.equal(remain[0].id, adminB);
  await assert.rejects(deactivateUser(db, adminB), AuthRejectError);

  // Phrase reset: create, consume with new phrase, single-use.
  const resetToken = await createPhraseReset(db, staff, adminB);
  assert.ok(resetToken.length > 20);
  await consumePhraseReset(db, resetToken, "brand new phrase 77!");
  await assert.rejects(consumePhraseReset(db, resetToken, "another phrase 88!"), AuthRejectError);
  const row = await q<{ phrase_hash: string }>(db,
    sql`SELECT phrase_hash FROM aa_users WHERE id = ${staff}`);
  assert.equal(await verifyPhrase(row[0].phrase_hash, "brand new phrase 77!"), true);
  assert.equal(await verifyPhrase(row[0].phrase_hash, "correct horse 99!"), false);
});
