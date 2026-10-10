// Admin ops part 2: step-up, sessions revoke, backup regen, force-logout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { createUser, grantStepup, listSessions, revokeSession,
  revokeOtherSessions, regenerateBackupCodes, forceLogout } from "./admin-ops";
import { tokenHashHex } from "./keys";
import { sha256, toHex } from "./crypto";

const databaseUrl = process.env.DATABASE_URL;
const tag = `ops2:${Date.now().toString(36)}`;

async function cleanup(db: Db) {
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_recovery_codes WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
}

test("admin ops part 2: stepup, sessions, backup regen, force-logout", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });

  const u = await createUser(db, `${tag}-u2@example.com`, "staff", null as never);
  const h1 = await tokenHashHex("sess-token-1");
  const h2 = await tokenHashHex("sess-token-2");
  const h3 = await tokenHashHex("sess-token-3");
  const sid1 = crypto.randomUUID(), sid2 = crypto.randomUUID(), sid3 = crypto.randomUUID();
  await q(db, sql`INSERT INTO aa_sessions (id_hash, user_id, session_version, absolute_expires_at, sid)
    VALUES (decode(${h1}, 'hex'), ${u}, 1, now() + interval '1 hour', ${sid1}),
           (decode(${h2}, 'hex'), ${u}, 1, now() + interval '1 hour', ${sid2}),
           (decode(${h3}, 'hex'), ${u}, 1, now() + interval '1 hour', ${sid3})`);

  await grantStepup(db, h1, "normal");
  const su1 = await q<{ stepup_until: string }>(db,
    sql`SELECT stepup_until::text AS stepup_until FROM aa_sessions WHERE encode(id_hash,'hex') = ${h1}`);
  const d1 = (Date.parse(su1[0].stepup_until) - Date.now()) / 1000;
  assert.ok(d1 > 280 && d1 <= 300, `normal ~300s, got ${d1}`);
  await grantStepup(db, h1, "strict");
  const su2 = await q<{ stepup_until: string }>(db,
    sql`SELECT stepup_until::text AS stepup_until FROM aa_sessions WHERE encode(id_hash,'hex') = ${h1}`);
  const d2 = (Date.parse(su2[0].stepup_until) - Date.now()) / 1000;
  assert.ok(d2 > 105 && d2 <= 120, `strict ~120s, got ${d2}`);

  const list = await listSessions(db, u, h1);
  assert.equal(list.length, 3);
  assert.equal(list.filter((s) => s.current).length, 1);
  await revokeSession(db, sid2, u);
  assert.equal((await listSessions(db, u, h1)).length, 2);
  const removed = await revokeOtherSessions(db, u, h1);
  assert.equal(removed, 1);
  const list3 = await listSessions(db, u, h1);
  assert.equal(list3.length, 1);
  assert.equal(list3[0].sid, sid1);

  const hashes = await Promise.all(Array.from({ length: 8 },
    (_, i) => sha256(`code-${i}-${Date.now()}`).then(toHex)));
  await regenerateBackupCodes(db, u, hashes);
  assert.equal((await q(db, sql`SELECT 1 FROM aa_recovery_codes WHERE user_id = ${u}`)).length, 8);

  await forceLogout(db, u);
  assert.equal((await listSessions(db, u, h1)).length, 0);
  const ver = await q<{ session_version: number }>(db,
    sql`SELECT session_version FROM aa_users WHERE id = ${u}`);
  assert.equal(ver[0].session_version, 2);
});
