// "Invalid or expired code" AFTER a correct email code + authenticator code.
// Cause pinned here: an ADMIN session must be bound to a registered device. A browser with no
// device cookie, while the one-time first-device window is closed, gets the neutral 401 on
// POST /auth/session. The client body stays neutral; the SERVER LOG (Workers Logs) now says why.
//   * window closed + no device cookie -> 401, neutral body, log carries the reason
//   * window open -> 200 and the device cookie is issued (the browser is registered)
//   * that same browser later (cookie sent) -> 200; a DIFFERENT browser -> 401 again
//   * the operator remedy (re-open the window) lets the new browser in, once
//   * every neutral 401 on the auth routes is logged with its audit reason, never sent to the client
// Live DB; fails fast without DATABASE_URL and refuses non-local databases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { authRoute } from "./routes";
import { q, sql } from "./sql";
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

function capture() {
  const lines: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return { lines, stop: () => { console.warn = w; } };
}

async function readySession(userId: string, email: string, extraCookies = "") {
  const vid = newVid(), addr = ip();
  const f = await newTotpFlow(db, s, { id: userId, email }, { vid, stage: "ready" });
  const log = capture();
  try {
    const res = await app.request("http://localhost/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost",
        "cf-connecting-ip": addr, "x-test-ip": addr, "user-agent": "sessden", cookie: `__Host-aaf=${f.token}; __Host-vid=${vid}${extraCookies}` },
      body: "{}",
    }, env);
    return { res, body: await res.text(), log: log.lines, setCookie: res.headers.get("set-cookie") ?? "" };
  } finally { log.stop(); }
}

const setWindow = (id: string, open: boolean) =>
  q(db, sql`UPDATE aa_users SET device_window_until = ${open ? sql`now() + interval '1 hour'` : sql`NULL`} WHERE id = ${id}::uuid`);

test("admin, no device cookie, window closed: neutral 401 to the client, precise reason in the server log", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-a@example.com`, { role: "admin" });
  await setWindow(u.id, false);
  const r = await readySession(u.id, u.email);
  assert.equal(r.res.status, 401);
  assert.deepEqual(JSON.parse(r.body), { error: "Invalid or expired code" });
  assert.doesNotMatch(r.body, /device|window/i, "the client learns nothing about devices");
  const log = r.log.find((l) => l.includes("auth_rejected"));
  assert.ok(log, "the rejection is logged");
  assert.match(log!, /no_registered_device\(cookie=0,window=0,active_devices=0\)/);
  assert.match(log!, /\/auth\/session/);
  assert.doesNotMatch(log!, new RegExp(u.email.replace(/[.+]/g, "\\$&")), "no email in the log");
});

test("window open: the browser is registered (device cookie issued); it then logs in again, a DIFFERENT browser does not", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-b@example.com`, { role: "admin" });
  await setWindow(u.id, true);
  const first = await readySession(u.id, u.email);
  assert.equal(first.res.status, 200, first.body);
  const did = /__Host-did=([^;]+)/.exec(first.setCookie)?.[1];
  assert.ok(did, "the first-device claim issues __Host-did");

  const same = await readySession(u.id, u.email, `; __Host-did=${did}`);
  assert.equal(same.res.status, 200, "the registered browser keeps working");

  const other = await readySession(u.id, u.email);                 // a second browser: no cookie, window now spent
  assert.equal(other.res.status, 401);
  assert.match(other.log.find((l) => l.includes("auth_rejected")) ?? "", /cookie=0,window=0,active_devices=1/);
});

test("operator remedy: re-opening the first-device window lets the new browser in, exactly once", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-c@example.com`, { role: "admin" });
  await setWindow(u.id, false);
  assert.equal((await readySession(u.id, u.email)).res.status, 401);
  await setWindow(u.id, true);                                      // UPDATE aa_users SET device_window_until = now() + interval '1 hour' WHERE email = ...
  const ok = await readySession(u.id, u.email);
  assert.equal(ok.res.status, 200, ok.body);
  assert.match(ok.setCookie, /__Host-did=/);
  assert.equal((await readySession(u.id, u.email)).res.status, 401, "the window was consumed by that one login");
});

test("every neutral 401 on the auth routes is logged with its audit reason and nothing else reaches the client", async () => {
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
  assert.ok(line, "logged");
  assert.match(line!, /"reason":"flow"/);
  assert.match(line!, /"path":"\/auth\/totp"/);
});
