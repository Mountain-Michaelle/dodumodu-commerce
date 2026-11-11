// Protected routing between the sign-in page and the admin pages, through the real dispatcher, using the
// REAL backend session (a cookie or a cached user object proves nothing).
//   * no / malformed / expired / revoked / version-bumped session: pages redirect to sign-in (with a safe
//     ?next=), APIs answer 401, the sign-in page itself always loads
//   * valid administrator: pages load; the sign-in page redirects to the console; no redirect loop
//   * staff session: sign-in page loads (no loop), admin pages/APIs answer 403 (not a redirect)
//   * logout and a session that dies while a page is open end up back at sign-in
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { app as composed } from "../app";
import { q, sql } from "../auth/sql";
import {
  openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow,
} from "../auth/mfa-test-kit";

const NS = "/4ehhi-5deggi";
const HOST = "shop.example.com";
const db = openTestDb();
const s = testSecrets();
const tag = makeTag("route");
const env = {
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "production", ADMIN_BASE_PATH: NS, ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
  RATE_LIMIT_ADMIN_PER_MINUTE: "100000", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "100000",
  RATE_LIMIT_KV: { get: async () => null, put: async () => undefined },
} as never;
after(async () => { await cleanupTag(db, tag); await closePools(); });

const NET = 1 + Math.floor(Math.random() * 200);
let n = 0;
const ip = () => `10.${NET}.77.${(n++ % 250) + 1}`;
const call = (method: string, path: string, cookie?: string) => {
  const origin = `https://${HOST}`, addr = ip();
  return composed.fetch(new Request(`${origin}${NS}${path}`, {
    method, redirect: "manual",
    headers: { host: HOST, origin, "cf-connecting-ip": addr, "x-test-ip": addr,
      ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: method === "GET" ? undefined : "{}",
  }), env);
};
async function signIn(label: string, role: "admin" | "staff" = "admin") {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role });
  await q(db, sql`UPDATE aa_users SET device_window_until = now() + interval '1 hour' WHERE id = ${u.id}::uuid`);
  const vid = newVid();
  const f = await newTotpFlow(db, s, u, { vid, stage: "ready" });
  const res = await call("POST", "/auth/session", `__Host-aaf=${f.token}; __Host-vid=${vid}`);
  assert.equal(res.status, 200, await res.text());
  const sc = res.headers.get("set-cookie") ?? "";
  const sid = /__Host-sid=([^;]+)/.exec(sc)![1];
  const did = /__Host-did=([^;]+)/.exec(sc)?.[1];
  return { u, cookie: `__Host-sid=${sid}${did ? `; __Host-did=${did}` : ""}; __Host-vid=${vid}` };
}
const PAGES = ["/users/", "/devices/", "/sessions/", "/users", "/devices", "/sessions"];
const goesToSignIn = (r: Response, page: string) => {
  assert.equal(r.status, 302, page);
  const loc = r.headers.get("location") ?? "";
  assert.ok(loc.startsWith(`${NS}/sign-in/?next=`), `${page} -> ${loc}`);
  const next = decodeURIComponent(loc.split("next=")[1]);
  assert.ok(next.startsWith(`${NS}/`) && !next.startsWith("//"), "next is a same-site path");
};

test("anonymous: pages redirect to sign-in (with a safe next), the console too, APIs answer 401, sign-in loads", async () => {
  for (const p of PAGES) goesToSignIn(await call("GET", p), p);
  const root = await call("GET", "/"); assert.equal(root.status, 302); assert.equal(root.headers.get("location"), `${NS}/sign-in/`);
  for (const p of ["/blocks", "/admin-v2/users", "/admin-v2/sessions", "/admin-v2/devices", "/auth/sessions"]) assert.equal((await call("GET", p)).status, 401, p);
  const page = await call("GET", "/sign-in/");
  assert.equal(page.status, 200); assert.match(page.headers.get("content-type") ?? "", /text\/html/);
});

test("a malformed or unknown session cookie is treated as signed out everywhere (and cannot block the sign-in page)", async () => {
  for (const cookie of ["__Host-sid=garbage", "__Host-sid=" + "a".repeat(200), "__Host-sid="]) {
    for (const p of PAGES) goesToSignIn(await call("GET", p, cookie), p);
    assert.equal((await call("GET", "/sign-in/", cookie)).status, 200);
    assert.equal((await call("GET", "/admin-v2/users", cookie)).status, 401);
  }
});

test("valid administrator: pages load; sign-in redirects to the console; the console loads (no loop)", async () => {
  const a = await signIn("admin");
  for (const p of PAGES.filter((x) => !x.startsWith("/users"))) assert.equal((await call("GET", p, a.cookie)).status, 200, p);
  const si = await call("GET", "/sign-in/", a.cookie);
  assert.equal(si.status, 302); assert.equal(si.headers.get("location"), `${NS}/`);
  assert.equal((await call("GET", "/sign-in", a.cookie)).status, 302);
  const root = await call("GET", "/", a.cookie);
  assert.equal(root.status, 200, "the place sign-in sends you to does not send you back");
  assert.equal((await call("GET", "/admin-v2/users", a.cookie)).status, 200);
});

test("expired, revoked and version-bumped sessions are signed out: pages redirect, APIs 401, sign-in loads (no loop)", async () => {
  const cases: Array<[string, (id: string) => Promise<unknown>]> = [
    ["expired", (id) => q(db, sql`UPDATE aa_sessions SET absolute_expires_at = now() - interval '1 minute' WHERE user_id = ${id}::uuid`)],
    ["revoked", (id) => q(db, sql`DELETE FROM aa_sessions WHERE user_id = ${id}::uuid`)],
    ["version", (id) => q(db, sql`UPDATE aa_users SET session_version = session_version + 1 WHERE id = ${id}::uuid`)],
    ["idle", (id) => q(db, sql`UPDATE aa_sessions SET last_seen_at = now() - interval '2 days' WHERE user_id = ${id}::uuid`)],
  ];
  for (const [label, kill] of cases) {
    const a = await signIn(`dead-${label}`);
    assert.equal((await call("GET", "/devices/", a.cookie)).status, 200, `${label}: alive first`);
    await kill(a.u.id);
    for (const p of PAGES) goesToSignIn(await call("GET", p, a.cookie), `${label} ${p}`);
    assert.equal((await call("GET", "/sign-in/", a.cookie)).status, 200, `${label}: sign-in page shown`);
    const api = await call("GET", "/admin-v2/devices", a.cookie);
    assert.equal(api.status, 401, `${label}: API`);
    assert.deepEqual(await api.json(), { error: "Not authenticated" }, "the 401 a page treats as 'session lost'");
  }
});

test("a session that dies while the page is open: the next API call is a 401 that sends the page to sign-in", async () => {
  const a = await signIn("open");
  assert.equal((await call("GET", "/admin-v2/devices", a.cookie)).status, 200);
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id = ${a.u.id}::uuid`);
  const res = await call("GET", "/admin-v2/devices", a.cookie);
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: string }).error, "Not authenticated");
});

test("staff session: sign-in page still loads (no loop); admin pages and APIs are 403, not redirects", async () => {
  const st = await signIn("staff", "staff");
  assert.equal((await call("GET", "/sign-in/", st.cookie)).status, 200);
  for (const p of ["/users/", "/devices/"]) assert.equal((await call("GET", p, st.cookie)).status, 403, p);
  for (const p of ["/admin-v2/sessions", "/admin-v2/devices?scope=all", "/admin-v2/users"]) assert.equal((await call("GET", p, st.cookie)).status, 403, p);
  assert.equal((await call("GET", "/auth/sessions", st.cookie)).status, 200, "staff can still see their own sessions");
});

test("logout ends access immediately; a fresh sign-in afterwards works", async () => {
  const a = await signIn("logout");
  assert.equal((await call("GET", "/devices/", a.cookie)).status, 200);
  assert.equal((await call("POST", "/auth/logout", a.cookie)).status, 200);
  goesToSignIn(await call("GET", "/devices/", a.cookie), "after logout");
  assert.equal((await call("GET", "/sign-in/", a.cookie)).status, 200);
  const again = await signIn("logout-again");
  assert.equal((await call("GET", "/devices/", again.cookie)).status, 200);
});

test("only GET navigations are redirected: a write to a page path is never turned into a redirect", async () => {
  const r = await call("POST", "/users/");
  assert.notEqual(r.status, 302);
});

test("the old standalone /users page is retired: an administrator is sent to Users & access in the console", async () => {
  const a = await signIn("users-redirect");
  for (const p of ["/users", "/users/"]) {
    const r = await call("GET", p, a.cookie);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get("location"), `${NS}/#users`, p);
  }
  assert.equal((await call("GET", "/assets/users.js", a.cookie)).status, 404, "its script is no longer served");
});
