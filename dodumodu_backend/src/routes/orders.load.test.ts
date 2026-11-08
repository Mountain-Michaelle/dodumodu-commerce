// Load / stampede test. LOAD_TEST_ORDERS (default 10000) orders are fired in the SAME
// instant through the real route + middleware + live Postgres, together with a burst of
// duplicate retries and a burst of real admin sign-ins. Pinned:
//   * nothing crashes, nothing answers 5xx; every distinct order is created exactly once
//   * duplicate retries (same idempotency key) never create a second order
//   * every order is auto-assigned to the PRIMARY account and the primary is notified once each
//   * sign-ins and the notification bell keep working while the stampede is running
//   * the process heap stays bounded
//   * the traffic is a VIRAL one: every order comes from a DIFFERENT IP, phone and device (so the
//     per-IP/phone rate limits are not what is being tested, and are proven not to interfere)
//   * every order is emailed to the backup address exactly once (one idempotency key each)
//   * when the database rejects a share of orders mid-storm, each rejected order still has its
//     backup copy AND a failure alert to the DB admin, and the rest are unaffected
// Live DB; fails fast without DATABASE_URL and refuses non-local databases.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { and, eq, like } from "drizzle-orm";
import type { Env } from "../env";
import { ordersRoute } from "./orders";
import { authRoute } from "../auth/routes";
import { products, orders } from "../schema";
import { q, q1, sql } from "../auth/sql";
import { setPrimaryUser } from "../auth/admin-ops";
import { notificationService } from "../services/notificationService";
import { ordersRepo } from "../data/ordersRepo";
import { flushOrderMail, resetOrderMailCache } from "../services/orderBackupMailer";
import {
  openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow,
} from "../auth/mfa-test-kit";

const N = Number(process.env.LOAD_TEST_ORDERS ?? 10000);
const DUPES = Math.min(500, Math.floor(N / 10));
const LOGINS = Math.min(200, Math.floor(N / 50));
const db = openTestDb();
const s = testSecrets();
const tag = makeTag("load");
const realFetch = globalThis.fetch;
let productId = 0;
let prevPrimary: string | null = null;
let primary: { id: string; email: string };
const emails: { to: string; subject: string; key: string }[] = [];

const app = new Hono<{ Bindings: Env }>();
app.route("/", ordersRoute);
app.route("/auth", authRoute as never);
const env = {
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "sandbox", TURNSTILE_SECRET_KEY: "0xs",
  MAX_ORDER_QUANTITY: "10", ASSIGNMENT_MODE_ENABLED: "true",
  RESEND_API_KEY: "re_test", AUTH_FROM_EMAIL: "orders@example.com", ORDER_BACKUP_EMAIL: `backup-${tag}@example.com`,
  ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
} as unknown as Env;

before(async () => {
  const prev = await q1<{ id: string }>(db, sql`SELECT id::text AS id FROM aa_users WHERE is_primary`);
  prevPrimary = prev?.id ?? null;
  await q(db, sql`UPDATE aa_users SET is_primary = false WHERE is_primary`);
  const u = await createEnrolledUser(db, s, `${tag}-boss@example.com`, { role: "admin" });
  await setPrimaryUser(db, u.id);
  primary = { id: u.id, email: u.email };
  const [p] = await db.insert(products).values({ slug: `${tag}-p`, name: "Load fixture", description: "x", price: 100000 }).returning();
  productId = p.id;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = String(i);
    if (url.includes("challenges.cloudflare.com")) {
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body));
      emails.push({ to: b.to, subject: b.subject, key: new Headers(init?.headers).get("Idempotency-Key") ?? "" });
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }
    return realFetch(i, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await q(db, sql`DELETE FROM admin_notifications WHERE dedupe_key IN
    (SELECT 'order-created:' || id FROM orders WHERE product_id = ${productId})`);
  await q(db, sql`DELETE FROM admin_notifications WHERE body LIKE ${"%" + tag + "%"}`);
  await q(db, sql`DELETE FROM order_assignments WHERE order_id IN (SELECT id FROM orders WHERE product_id = ${productId})`);
  await q(db, sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE product_id = ${productId})`);
  await db.delete(orders).where(eq(orders.productId, productId));
  await db.delete(products).where(eq(products.id, productId));
  await q(db, sql`UPDATE aa_users SET is_primary = false WHERE email LIKE ${tag + "%"}`);
  if (prevPrimary) await q(db, sql`UPDATE aa_users SET is_primary = true WHERE id = ${prevPrimary}::uuid`).catch(() => {});
  await cleanupTag(db, tag);
  await closePools();
});

// Injective: every index maps to a different, valid IPv4 (last octet 1..254).
const ipOf = (i: number) => `11.${(Math.floor(i / 254) >> 8) & 255}.${Math.floor(i / 254) & 255}.${(i % 254) + 1}`;
// A valid UUID per index (the route requires UUID idempotency keys); the run tag makes them unique per run.
const runSalt = crypto.randomUUID().slice(0, 8);
const keyOf = (i: number) => `${runSalt}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
const phoneOf = (i: number) => `0803${String(1000000 + i).slice(-7)}`;
const orderReq = (i: number, key = keyOf(i)) => app.request("/create-order", {
  method: "POST",
  // A different person on a different network and device for every order.
  headers: { "content-type": "application/json", "cf-connecting-ip": ipOf(i), "x-dodumodu-device": `dev-${runSalt}-${i}` },
  body: JSON.stringify({
    idempotencyKey: key, turnstileToken: `t-${i}`, productId, quantity: 1, customerName: `Load ${i}`,
    phone: phoneOf(i), whatsapp: phoneOf(i), address: `${i} Stampede Street`, state: "Lagos",
    deliveryDate: "tomorrow", paymentMethod: "cod",
  }),
}, env);

test(`${N} simultaneous orders + duplicate retries + admin sign-ins: no crash, no 5xx, no duplicates`, { timeout: 900_000 }, async () => {
  // Staff users + ready flows for the concurrent sign-ins.
  const logins: { token: string; vid: string; ip: string }[] = [];
  for (let i = 0; i < LOGINS; i++) {
    const u = await createEnrolledUser(db, s, `${tag}-staff${i}@example.com`, { nCodes: 1 });
    const vid = newVid();
    const f = await newTotpFlow(db, s, u, { vid, trusted: true, stage: "ready" });
    logins.push({ token: f.token, vid, ip: `12.0.${Math.floor(i / 250)}.${(i % 250) + 1}` });
  }
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  const latencies: number[] = new Array(N);

  const orderCalls = Array.from({ length: N }, async (_, i) => {
    const t = Date.now();
    const r = await orderReq(i);
    latencies[i] = Date.now() - t;
    return r.status;
  });
  // Duplicate retries of the first DUPES keys, fired in the same instant as everything else.
  const dupeCalls = Array.from({ length: DUPES }, async (_, i) => (await orderReq(i)).status);
  const loginCalls = logins.map(async (l) => (await app.request("http://localhost/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost",
      "cf-connecting-ip": l.ip, "x-test-ip": l.ip, cookie: `__Host-aaf=${l.token}; __Host-vid=${l.vid}` },
    body: "{}",
  }, env)).status);

  const [orderStatuses, dupeStatuses, loginStatuses] = await Promise.all([
    Promise.all(orderCalls), Promise.all(dupeCalls), Promise.all(loginCalls),
  ]);
  const elapsed = Date.now() - t0;
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(JSON.stringify({
    event: "load_test_result", orders: N, duplicates: DUPES, logins: LOGINS, elapsedMs: elapsed,
    ordersPerSec: Math.round((N * 1000) / elapsed),
    p50: sorted[Math.floor(N * 0.5)], p95: sorted[Math.floor(N * 0.95)], p99: sorted[Math.floor(N * 0.99)],
    heapGrowthMB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e6),
  }));

  await flushOrderMail();
  const bad = (arr: number[]) => arr.filter((x) => x !== 200);
  assert.deepEqual(bad(orderStatuses).slice(0, 5), [], "every order answered 200");
  assert.deepEqual(bad(dupeStatuses).slice(0, 5), [], "every duplicate retry answered 200");
  assert.deepEqual(bad(loginStatuses).slice(0, 5), [], "every concurrent sign-in answered 200");

  const stats = await q1<{ n: number; refs: number; assigned: number; wrong: number }>(db, sql`
    SELECT count(*)::int AS n, count(DISTINCT reference)::int AS refs,
           count(*) FILTER (WHERE assigned_to = ${primary.email})::int AS assigned,
           count(*) FILTER (WHERE assigned_to IS DISTINCT FROM ${primary.email})::int AS wrong
      FROM orders WHERE product_id = ${productId}`);
  assert.equal(stats!.n, N, "exactly one row per distinct order: duplicates created nothing");
  assert.equal(stats!.refs, N, "every reference is unique");
  assert.equal(stats!.assigned, N, "every order is assigned to the primary account");
  assert.equal(stats!.wrong, 0);

  const spread = await q1<{ ips: number; devices: number; phones: number }>(db, sql`
    SELECT count(DISTINCT created_from_ip)::int AS ips, count(DISTINCT device_id)::int AS devices,
           count(DISTINCT phone_norm)::int AS phones
      FROM orders WHERE product_id = ${productId}`);
  assert.deepEqual(spread, { ips: N, devices: N, phones: N },
    "a viral crowd: every order is from a different IP, device and phone, so no per-IP/phone limit applies");

  const backups = emails.filter((m) => m.to === env.ORDER_BACKUP_EMAIL && m.subject.startsWith("[ORDER]"));
  assert.equal(new Set(backups.map((m) => m.key)).size, N, "one backup email (idempotency key) per distinct order");
  assert.equal(emails.filter((m) => m.subject.startsWith("[ORDER NOT SAVED]")).length, 0, "no failure alert when everything saved");

  const notified = await q1<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM admin_notifications
     WHERE recipient_user_id = ${primary.id}::uuid AND type = 'order_created'
       AND dedupe_key IN (SELECT 'order-created:' || id FROM orders WHERE product_id = ${productId})`);
  assert.equal(notified!.n, N, "the primary was notified exactly once per order");
  assert.equal(await notificationService.unreadCount(db, primary.id) >= N, true);

  const sessions = await q1<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM aa_sessions WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "-staff%"})`);
  assert.equal(sessions!.n, LOGINS, "one session per sign-in");
  const loginBell = await q1<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM admin_notifications
     WHERE recipient_user_id = ${primary.id}::uuid AND type = 'login_success' AND body LIKE ${"%" + tag + "%"}`);
  assert.equal(loginBell!.n, LOGINS, "every sign-in reached the bell");
  assert.ok((process.memoryUsage().heapUsed - heapBefore) / 1e6 < 1500, "heap stayed bounded");
});


test("database rejecting a share of orders mid-storm: every rejected order still has a backup copy and an admin alert", { timeout: 600_000 }, async () => {
  const M = Math.max(30, Math.floor(N / 10));
  const base = N + 10_000;                       // fresh keys/IPs/phones, disjoint from the first test
  const doomed = (i: number) => i % 5 === 0;     // 20% rejected by the "database"
  emails.length = 0;
  resetOrderMailCache();
  const originalInsert = ordersRepo.insert;
  ordersRepo.insert = async (dbx, values) => {
    if (String(values.customerName).startsWith("Doomed")) throw new Error("connection terminated unexpectedly");
    return originalInsert(dbx, values);
  };
  try {
    const statuses = await Promise.all(Array.from({ length: M }, async (_, k) => {
      const i = base + k;
      const r = await Promise.resolve(app.request("/create-order", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ipOf(i), "x-dodumodu-device": `dev-${runSalt}-${i}` },
        body: JSON.stringify({
          idempotencyKey: keyOf(i), turnstileToken: `t-${i}`, productId, quantity: 1,
          customerName: `${doomed(k) ? "Doomed" : "Fine"} ${i}`, phone: phoneOf(i), whatsapp: phoneOf(i),
          address: `${i} Stampede Street`, state: "Lagos", deliveryDate: "tomorrow", paymentMethod: "cod" }),
      }, env)).catch(() => ({ status: 500 }) as Response);
      return { k, status: r.status };
    }));
    await flushOrderMail();
    const rejected = statuses.filter((x) => doomed(x.k));
    assert.ok(rejected.every((x) => x.status === 500), "rejected orders are reported as failures to the customer");
    assert.ok(statuses.filter((x) => !doomed(x.k)).every((x) => x.status === 200), "healthy orders are unaffected");
    const saved = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.productId, productId), like(orders.customerName, "Fine %")));
    assert.equal(saved.length, M - rejected.length);

    const keysOf = (pred: (m: { to: string; subject: string }) => boolean) =>
      new Set(emails.filter(pred).map((m) => m.key.replace(/:\d+$/, "")));
    const backupKeys = keysOf((m) => m.to === env.ORDER_BACKUP_EMAIL && m.subject.startsWith("[ORDER]"));
    const alertKeys = keysOf((m) => m.to === primary.email && m.subject.startsWith("[ORDER NOT SAVED]"));
    assert.equal(backupKeys.size, M, "every order, saved or not, was captured by email");
    assert.equal(alertKeys.size, rejected.length, "every rejected order alerted the DB admin exactly once");
  } finally {
    ordersRepo.insert = originalInsert;
  }
});
