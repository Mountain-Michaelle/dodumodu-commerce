import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "../auth/sql";
import { notificationService } from "./notificationService";

const databaseUrl = process.env.NOTIFICATION_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test("notification records are scoped, deduplicated, and mark-read persistently", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => closePools());
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [adminA] = await q<{ id: string }>(db, sql`
    INSERT INTO aa_users (email, role, is_active)
    VALUES (${`notification-a-${suffix}@example.test`}, 'admin', true)
    RETURNING id::text AS id`);
  const [adminB] = await q<{ id: string }>(db, sql`
    INSERT INTO aa_users (email, role, is_active)
    VALUES (${`notification-b-${suffix}@example.test`}, 'admin', true)
    RETURNING id::text AS id`);

  try {
    const created = await notificationService.createForAdmins(db, {
      type: "order_created",
      title: "New order received",
      body: `DDMD-${suffix}`,
      href: "/orders/42",
      dedupeKey: `test-order-${suffix}`,
    });
    assert.ok(created >= 2);
    assert.equal(await notificationService.createForAdmins(db, {
      type: "order_created",
      title: "New order received",
      body: `DDMD-${suffix}`,
      href: "/orders/42",
      dedupeKey: `test-order-${suffix}`,
    }), 0);

    const listA = await notificationService.list(db, adminA.id);
    const listB = await notificationService.list(db, adminB.id);
    assert.equal(listA.filter((row) => row.body.includes(suffix)).length, 1);
    assert.equal(listB.filter((row) => row.body.includes(suffix)).length, 1);
    assert.equal(await notificationService.unreadCount(db, adminA.id), 1);

    const item = listA.find((row) => row.body.includes(suffix));
    assert.ok(item);
    assert.equal(await notificationService.markRead(db, adminB.id, item!.id), false);
    assert.equal(await notificationService.markRead(db, adminA.id, item!.id), true);
    assert.equal(await notificationService.unreadCount(db, adminA.id), 0);
  } finally {
    await q(db, sql`DELETE FROM aa_users WHERE id IN (${adminA.id}::uuid, ${adminB.id}::uuid)`);
  }
});
