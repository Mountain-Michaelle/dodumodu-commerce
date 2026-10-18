// Admin ops part 1: perms, create, guards, phrase reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { createUser, grantPerm, revokePerm, deactivateUser } from "./admin-ops";
import { PERMISSIONS } from "./config";
import { AuthRejectError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
const tag = `ops-${Date.now().toString(36)}`;

async function cleanup(db: Db) {
  await q(db, sql`DELETE FROM aa_user_permissions WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_phrase_resets WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE '%'`);
}

test("admin ops part 1: perms, create, guards", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  // The last-admin guard is GLOBAL by spec. Park any pre-existing active admins
  // (the E2E seed keeps one) so this test owns the world, restore afterward.
  const parked = await q<{ id: string }>(db,
    sql`UPDATE aa_users SET is_active = false
        WHERE role = 'admin' AND is_active AND email NOT LIKE ${tag + "%"}
        RETURNING id::text AS id`);
  t.after(async () => {
    for (const r of parked) {
      await q(db, sql`UPDATE aa_users SET is_active = true WHERE id = ${r.id}::uuid`);
    }
    await cleanup(db); await closePools();
  });

  const adminA = await createUser(db, `${tag}-a@example.com`, "admin", null as never);
  const adminB = await createUser(db, `${tag}-b@example.com`, "admin", adminA);
  const staff = await createUser(db, `${tag}-s@example.com`, "general", adminA);

  await grantPerm(db, staff, PERMISSIONS.ordersView, adminA);
  const perms = await q<{ perm: string }>(db,
    sql`SELECT perm FROM aa_user_permissions WHERE user_id = ${staff}`);
  assert.deepEqual(perms.map((p) => p.perm), [PERMISSIONS.ordersView]);
  await revokePerm(db, staff, PERMISSIONS.ordersView);
  assert.equal((await q(db, sql`SELECT 1 FROM aa_user_permissions WHERE user_id = ${staff}`)).length, 0);
  await assert.rejects(grantPerm(db, staff, "not.a.perm", adminA), AuthRejectError);
  await assert.rejects(createUser(db, `${tag}-s@example.com`, "general", adminA), AuthRejectError);

  // Last-admin guard.
  await deactivateUser(db, adminA);
  const remain = await q<{ id: string }>(db,
    sql`SELECT id FROM aa_users WHERE role = 'admin' AND is_active AND email LIKE ${tag + "%"} ORDER BY id`);
  assert.equal(remain.length, 1);
  assert.equal(remain[0].id, adminB);
  await assert.rejects(deactivateUser(db, adminB), AuthRejectError);
});
