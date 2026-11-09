// Lost or cleared cookies must never lock a correctly authenticated admin out.
// Real incident: email code + authenticator code accepted, then POST /auth/session answered the
// neutral 401 because the browser held no registered device (cookie cleared / new site address)
// and the one-time first-device window was closed.
// Rule now: both factors passed => the user gets in. A browser with no registered device
//   * receives a STRICT session (shorter life, stricter step-up) and a fresh device cookie,
//   * is registered as an active device with created_via = 'new_browser' (visible + revocable),
//   * is logged server-side, and a registered browser keeps its normal session and adds no device,
//   * is capped: only the newest MAX_ACTIVE_DEVICES stay active, so clearing cookies repeatedly
//     can't grow the table (retired devices' sessions end with them).
// A flow that is NOT at the 'ready' stage is still refused (neutral 401, reason logged).
// Live DB; fails fast without DATABASE_URL and refuses non-local databases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { authRoute } from "./routes";
import { q, q1, sql } from "./sql";
import { lookupSession } from "./session-lookup";
import { MAX_ACTIVE_DEVICES } from "./config";
import {
  openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow,
} from "./mfa-test-kit";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("sessden");
const env = {
  DATABASE_URL: process.env.DATABASE_URL!, ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
} as never;
const app = new Hono();
app.route("/auth", authRoute as never);
after(async () => { await cleanupTag(db, tag); await closePools(); });

let n = 0;
const ip = () => `10.98.${Math.floor(n / 250) + 1}.${(n++ % 250) + 1}`;

function capture(method: "warn" | "error" = "warn") {
  const lines: string[] = [];
  const orig = console[method];
  console[method] = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return { lines, stop: () => { console[method] = orig; } };
}

async function login(u: { id: string; email: string }, cookies = "", stage = "ready") {
  const vid = newVid(), addr = ip();
  const f = await newTotpFlow(db, s, u, { vid, stage });
  const log = capture();
  try {
    const res = await app.request("http://localhost/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost",
        "cf-connecting-ip": addr, "x-test-ip": addr, "user-agent": "sessden", cookie: `__Host-aaf=${f.token}; __Host-vid=${vid}${cookies}` },
      body: "{}",
    }, env);
    const setCookie = res.headers.get("set-cookie") ?? "";
    return {
      res, body: await res.text(), log: log.lines, setCookie,
      sid: /__Host-sid=([^;]+)/.exec(setCookie)?.[1], did: /__Host-did=([^;]+)/.exec(setCookie)?.[1],
    };
  } finally { log.stop(); }
}

const admin = async (label: string, window = false) => {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role: "admin" });
  await q(db, sql`UPDATE aa_users SET device_window_until = ${window ? sql`now() + interval '1 hour'` : sql`NULL`} WHERE id = ${u.id}::uuid`);
  return u;
};
const devices = (id: string) => q<{ status: string; created_via: string }>(db,
  sql`SELECT status, created_via FROM aa_admin_devices WHERE user_id = ${id}::uuid ORDER BY created_at`);

test("lost cookie, window closed: NOT locked out - strict session, new device cookie, device registered", async () => {
  const u = await admin("lost");
  const r = await login(u);
  assert.equal(r.res.status, 200, r.body);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.ok(r.sid && r.did, "session cookie and a fresh device cookie are issued");
  const sess = await lookupSession(db, decodeURIComponent(r.sid!));
  assert.ok(sess, "the session works for admin routes");
  assert.equal(sess.tier, "strict");
  assert.deepEqual(await devices(u.id), [{ status: "active", created_via: "new_browser" }]);
  assert.ok(r.log.some((l) => l.includes("new_browser_device_registered")), "recorded server-side");
});

test("the browser then logs in normally with its new cookie: no extra device, normal tier", async () => {
  const u = await admin("again");
  const first = await login(u);
  const again = await login(u, `; __Host-did=${first.did}`);
  assert.equal(again.res.status, 200);
  assert.equal(again.did, undefined, "a known browser is not issued another device");
  assert.equal((await devices(u.id)).length, 1);
  const sess = await lookupSession(db, decodeURIComponent(again.sid!));
  assert.equal(sess!.tier, "normal");
});

test("an existing trusted device is untouched when ANOTHER browser logs in", async () => {
  const u = await admin("two", true);
  const trusted = await login(u);                                   // first-device claim
  assert.equal((await lookupSession(db, decodeURIComponent(trusted.sid!)))!.tier, "normal");
  const other = await login(u);                                     // no cookie, window spent
  assert.equal(other.res.status, 200);
  assert.equal((await lookupSession(db, decodeURIComponent(other.sid!)))!.tier, "strict");
  assert.deepEqual((await devices(u.id)).map((d) => d.created_via), ["first_login", "new_browser"]);
  const still = await login(u, `; __Host-did=${trusted.did}`);      // the trusted browser still gets a NORMAL session
  assert.equal((await lookupSession(db, decodeURIComponent(still.sid!)))!.tier, "normal");
});

test("migration 0026 not applied yet: login still works (device registered under an allowed type, loudly logged)", async () => {
  await q(db, sql`ALTER TABLE aa_admin_devices DROP CONSTRAINT IF EXISTS aa_admin_devices_created_via_check`);
  await q(db, sql`ALTER TABLE aa_admin_devices ADD CONSTRAINT aa_admin_devices_created_via_check
    CHECK (created_via IN ('first_login','invite','admin_invite','operator')) NOT VALID`);   // NOT VALID: earlier tests' rows stay
  try {
    const u = await admin("nomig");
    const log = capture("error");
    let r;
    try { r = await login(u); } finally { log.stop(); }
    assert.equal(r.res.status, 200, r.body);
    assert.ok(r.sid && r.did);
    assert.equal((await lookupSession(db, decodeURIComponent(r.sid!)))!.tier, "strict");
    assert.deepEqual((await devices(u.id)).map((d) => d.created_via), ["operator"]);
    assert.ok(log.lines.some((l) => l.includes("migration_0026_not_applied")), "the missing migration is visible in the logs");
  } finally {
    await q(db, sql`ALTER TABLE aa_admin_devices DROP CONSTRAINT IF EXISTS aa_admin_devices_created_via_check`);
    await q(db, sql`ALTER TABLE aa_admin_devices ADD CONSTRAINT aa_admin_devices_created_via_check
      CHECK (created_via IN ('first_login','invite','admin_invite','operator','new_browser'))`);
  }
});

test("a forged device cookie is never honoured: it is replaced like any unknown browser", async () => {
  const u = await admin("forged");
  const r = await login(u, "; __Host-did=forged-value");
  assert.equal(r.res.status, 200);
  assert.ok(r.did && r.did !== "forged-value");
  assert.equal((await lookupSession(db, decodeURIComponent(r.sid!)))!.tier, "strict");
});

test(`clearing cookies over and over is capped at ${MAX_ACTIVE_DEVICES} active devices`, async () => {
  const u = await admin("cap");
  for (let i = 0; i < MAX_ACTIVE_DEVICES + 3; i++) assert.equal((await login(u)).res.status, 200);
  const rows = await devices(u.id);
  assert.equal(rows.filter((d) => d.status === "active").length, MAX_ACTIVE_DEVICES);
  assert.equal(rows.filter((d) => d.status === "revoked").length, 3, "the oldest were retired");
});

test("a flow that is not at the ready stage is still refused: neutral 401, reason in the log only", async () => {
  const u = await admin("early");
  const r = await login(u, "", "totp");
  assert.equal(r.res.status, 401);
  assert.deepEqual(JSON.parse(r.body), { error: "Invalid or expired code" });
  const line = r.log.find((l) => l.includes("auth_rejected"));
  assert.ok(line);
  assert.match(line!, /"reason":"flow"/);
  assert.doesNotMatch(line!, new RegExp(u.email.replace(/[.+]/g, "\\$&")));
  assert.equal(await q1(db, sql`SELECT 1 FROM aa_admin_devices WHERE user_id = ${u.id}::uuid`), null, "no device was created");
});

test("every neutral 401 on the auth routes is logged with its audit reason, never sent to the client", async () => {
  const log = capture();
  let res: Response; let body: string;
  try {
    res = await app.request("http://localhost/auth/totp", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", "cf-connecting-ip": ip(), "x-test-ip": "10.98.250.1" },
      body: JSON.stringify({ code: "123456" }),
    }, env);
    body = await res.text();
  } finally { log.stop(); }
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(body), { error: "Invalid or expired code" });
  const line = log.lines.find((l) => l.includes("auth_rejected"));
  assert.ok(line);
  assert.match(line!, /"reason":"flow"/);
  assert.match(line!, /"path":"\/auth\/totp"/);
});