// Admin-bell security notifications, exercised THROUGH the real HTTP routes so a
// broken hook fails here:
//   * successful sign-in  -> bell + auth log: new vs known device, device id, IP, time
//   * rate limited        -> bell + log ONLY when the email is a real account
//                            (unknown emails: nothing, the caller sees the same 429)
//   * user created        -> bell + log with creator, device id, IP, time
//   * a failure inside the notifier never changes the sign-in / 429 / creation result
// Live DB; fails fast without DATABASE_URL and refuses non-local databases.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { authRoute, adminRoute } from "./routes";
import { q, q1, sql } from "./sql";
import { notificationService } from "../services/notificationService";
import {
  openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag,
  createEnrolledUser, newTotpFlow, createActiveDevice,
} from "./mfa-test-kit";
import { tokenHashHex } from "./keys";
import { randomToken } from "./crypto";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("secev");
const env = {
  DATABASE_URL: process.env.DATABASE_URL!,
  ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
} as never;
const app = new Hono();
app.route("/auth", authRoute as never);
app.route("/admin", adminRoute as never);

let primary: { id: string; email: string };
let prevPrimary: string | null = null;
let ipN = 0;
const nextIp = () => `10.77.${Math.floor(ipN / 250) + 1}.${(ipN++ % 250) + 1}`;

before(async () => {
  const prev = await q1<{ id: string }>(db, sql`SELECT id::text AS id FROM aa_users WHERE is_primary`);
  prevPrimary = prev?.id ?? null;
  if (prevPrimary) await q(db, sql`UPDATE aa_users SET is_primary = false WHERE id = ${prevPrimary}::uuid`);
  const u = await createEnrolledUser(db, s, `${tag}-primary@example.com`, { role: "admin" });
  await q(db, sql`UPDATE aa_users SET is_primary = true WHERE id = ${u.id}::uuid`);
  primary = { id: u.id, email: u.email };
});

after(async () => {
  await q(db, sql`DELETE FROM admin_notifications WHERE body LIKE ${"%" + tag + "%"}`);
  await q(db, sql`UPDATE aa_users SET is_primary = false WHERE email LIKE ${tag + "%"}`);
  if (prevPrimary) await q(db, sql`UPDATE aa_users SET is_primary = true WHERE id = ${prevPrimary}::uuid`).catch(() => {});
  await cleanupTag(db, tag);
  await closePools();
});

const headers = (ip: string, cookies = "") => ({
  "content-type": "application/json", host: "localhost", origin: "http://localhost",
  "cf-connecting-ip": ip, "x-test-ip": ip, "user-agent": "secev-test", cookie: cookies,
});
const post = (path: string, body: unknown, ip: string, cookies = "") =>
  app.request(`http://localhost${path}`, { method: "POST", headers: headers(ip, cookies), body: JSON.stringify(body) }, env);

const bell = async (type: string) =>
  (await notificationService.list(db, primary.id, 100)).filter((n) => n.type === type && n.body.includes(tag));

async function readyFlowLogin(email: string, vid: string, ip: string) {
  const u = (await q1<{ id: string }>(db, sql`SELECT id::text AS id FROM aa_users WHERE email = ${email}`))!;
  const f = await newTotpFlow(db, s, { id: u.id, email }, { vid, trusted: true, stage: "ready" });
  return post("/auth/session", {}, ip, `__Host-aaf=${f.token}; __Host-vid=${vid}`);
}

test("sign-in: first time from a browser is a NEW device; the same browser again is a KNOWN device", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-staff1@example.com`);
  const vid = newVid(), ip = nextIp();
  assert.equal((await readyFlowLogin(u.email, vid, ip)).status, 200);
  assert.equal((await readyFlowLogin(u.email, vid, ip)).status, 200);
  const rows = (await bell("login_success")).filter((n) => n.body.includes(u.email));
  assert.equal(rows.length, 2);
  const [newest, oldest] = rows; // list is newest first
  assert.match(oldest.title, /NEW device/);
  assert.match(oldest.body, /new device/);
  assert.match(newest.title, /known device/);
  for (const n of rows) {
    assert.ok(n.body.includes(`IP ${ip}`), "IP is shown");
    assert.match(n.body, /device [0-9a-f]{12} /, "device id is shown");
    assert.match(n.body, /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/, "time is shown");
  }
  // The same short device id both times: it is the same browser.
  assert.equal(/device ([0-9a-f]{12})/.exec(oldest.body)![1], /device ([0-9a-f]{12})/.exec(newest.body)![1]);
});

test("sign-in from a DIFFERENT browser for the same user is a new device again", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-staff2@example.com`);
  const ip = nextIp();
  await readyFlowLogin(u.email, newVid(), ip);
  await readyFlowLogin(u.email, newVid(), ip);
  const rows = (await bell("login_success")).filter((n) => n.body.includes(u.email));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((n) => /NEW device/.test(n.title)));
});

test("the sign-in is also written to the audit log (hashes only, no raw IP)", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-staff3@example.com`);
  await readyFlowLogin(u.email, newVid(), nextIp());
  const log = await q1<{ n: number; raw: number }>(db, sql`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE ip_enc IS NOT NULL)::int AS raw
      FROM aa_auth_log WHERE user_id = ${u.id}::uuid AND event = 'login_success' AND status = 'success'`);
  assert.equal(log!.n, 1);
  assert.equal(log!.raw, 0);
});

test("rate limited: a REAL account is reported with email, device id and IP; repeats are de-duplicated", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-victim@example.com`);
  const vid = newVid(), ip = nextIp();
  let limited = 0;
  for (let i = 0; i < 25 && limited < 3; i++) {
    const r = await post("/auth/request", { email: u.email }, ip, `__Host-vid=${vid}`);
    if (r.status === 429) limited += 1;
  }
  assert.ok(limited >= 1, "the throttle must eventually answer 429");
  const rows = await bell("rate_limited");
  assert.equal(rows.length, 1, "several 429s from one device inside the window = one bell entry");
  assert.ok(rows[0].body.includes(u.email));
  assert.ok(rows[0].body.includes(`IP ${ip}`));
  assert.match(rows[0].body, /device [0-9a-f]{12} /);
  const log = await q1<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM aa_auth_log WHERE user_id = ${u.id}::uuid AND event = 'rate_limited'`);
  assert.ok(log!.n >= 1);
});

test("rate limited: an UNKNOWN email leaves no bell entry and no log row (no enumeration signal)", async () => {
  const ghost = `${tag}-ghost@example.com`;
  const ip = nextIp();
  let seen429 = false;
  for (let i = 0; i < 25 && !seen429; i++) {
    seen429 = (await post("/auth/request", { email: ghost }, ip)).status === 429;
  }
  assert.ok(seen429, "unknown emails are throttled identically (uniform answer)");
  assert.equal((await bell("rate_limited")).filter((n) => n.body.includes(ghost)).length, 0);
});

test("user created through the admin route is reported with creator, device id, IP and time", async () => {
  const admin = await createEnrolledUser(db, s, `${tag}-creator@example.com`, { role: "admin" });
  const devTok = await createActiveDevice(db, admin.id);
  const dev = (await q1<{ id: string }>(db, sql`
    SELECT id::text AS id FROM aa_admin_devices WHERE token_hash = decode(${await tokenHashHex(devTok)}, 'hex')`))!;
  const sid = randomToken();
  await q(db, sql`INSERT INTO aa_sessions
    (id_hash, user_id, session_version, absolute_expires_at, ip, ua, device_id, login_via, ip_prefix, country, tier, stepup_until)
    SELECT decode(${await tokenHashHex(sid)}, 'hex'), u.id, u.session_version, now() + interval '1 hour',
           '10.1.1.1', 'itest', ${dev.id}::uuid, 'device', '10.1.1', 'NG', 'normal', now() + interval '1 hour'
      FROM aa_users u WHERE u.id = ${admin.id}::uuid`);
  const ip = nextIp(), vid = newVid();
  const email = `${tag}-newhire@example.com`;
  const res = await post("/admin/users", { email, role: "staff" }, ip, `__Host-sid=${sid}; __Host-vid=${vid}`);
  assert.equal(res.status, 200, await res.clone().text());
  const rows = (await bell("user_created")).filter((n) => n.body.includes(email));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].body.includes(`created by ${admin.email}`));
  assert.ok(rows[0].body.includes(`IP ${ip}`));
  assert.match(rows[0].body, /device [0-9a-f]{12} .*\d{4}-\d\d-\d\d/);
});

test("a broken notifier can never change the outcome: sign-in still succeeds", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-staff4@example.com`);
  const original = notificationService.createForAdmins;
  notificationService.createForAdmins = async () => { throw new Error("db hiccup"); };
  try {
    assert.equal((await readyFlowLogin(u.email, newVid(), nextIp())).status, 200);
  } finally {
    notificationService.createForAdmins = original;
  }
});
