// The admin DATA routes (/blocks, /orders, ...) authenticate the person who signed in.
// Real incident: after signing in (email code + authenticator, __Host-sid cookie) every data route
// answered 401 "Sign in to use the admin", because these routes only looked for the Cloudflare
// Access header and this deployment does not use Access. Worse, the same code trusted that header
// from ANYONE when Access is not in front, so a forged header was an administrator.
//   * admin-auth v2 ON  : a valid admin session is accepted; the Access header is IGNORED (forgeable)
//   * TRUST_ACCESS_HEADER=1 : the header is accepted again (deployments that really sit behind Access)
//   * admin-auth v2 OFF : legacy behaviour unchanged (header accepted)
//   * staff sessions get 403 here (staff use the scoped /admin-v2 routes), revoked sessions 401
//   * cookie-authenticated WRITES must come from this site (Origin == Host), reads are unaffected
//   * ADMIN_OPERATORS still narrows who may use it
// Live DB; fails fast without DATABASE_URL and refuses non-local databases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { adminRoute } from "./admin";
import { authRoute } from "../auth/routes";
import { q, sql } from "../auth/sql";
import {
  openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow,
} from "../auth/mfa-test-kit";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("admsess");
const base = {
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "sandbox", ALLOW_TEST_IP: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
  RATE_LIMIT_ADMIN_PER_MINUTE: "100000", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "100000",
};
const v2 = { ...base, ADMIN_AUTH_V2: "1" } as never;
const app = new Hono();
app.route("/auth", authRoute as never);
app.route("/", adminRoute as never);
after(async () => { await cleanupTag(db, tag); await closePools(); });

let n = 0;
const ip = () => `10.97.${Math.floor(n / 250) + 1}.${(n++ % 250) + 1}`;

async function signIn(label: string, role: "admin" | "staff") {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role });
  await q(db, sql`UPDATE aa_users SET device_window_until = now() + interval '1 hour' WHERE id = ${u.id}::uuid`);
  const vid = newVid(), addr = ip();
  const f = await newTotpFlow(db, s, u, { vid, stage: "ready" });
  const res = await app.request("http://localhost/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost",
      "cf-connecting-ip": addr, "x-test-ip": addr, "user-agent": "admsess", cookie: `__Host-aaf=${f.token}; __Host-vid=${vid}` },
    body: "{}",
  }, v2);
  assert.equal(res.status, 200, await res.text());
  const sc = res.headers.get("set-cookie") ?? "";
  const sid = /__Host-sid=([^;]+)/.exec(sc)![1];
  const did = /__Host-did=([^;]+)/.exec(sc)?.[1];
  return { u, cookie: `__Host-sid=${sid}${did ? `; __Host-did=${did}` : ""}; __Host-vid=${vid}`, sid };
}

const get = (path: string, env: unknown, headers: Record<string, string> = {}) =>
  app.request(`http://localhost${path}`, { headers: { host: "localhost", "cf-connecting-ip": ip(), "x-test-ip": ip(), ...headers } }, env as never);

test("a signed-in admin can use the admin data routes (the reported failure)", async () => {
  const a = await signIn("ok", "admin");
  const res = await get("/blocks", v2, { cookie: a.cookie });
  assert.equal(res.status, 200, await res.clone().text());
});

test("no session and no header: 401 with the neutral admin message", async () => {
  const res = await get("/blocks", v2);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: { code: "UNAUTHORIZED", message: "Sign in to use the admin" } });
});

test("SECURITY: a forged Cloudflare Access header is NOT an administrator when Access is not in use", async () => {
  const res = await get("/blocks", v2, { "cf-access-authenticated-user-email": "attacker@example.com" });
  assert.equal(res.status, 401);
});

test("a deployment that really is behind Access opts in with TRUST_ACCESS_HEADER=1 and the header works again", async () => {
  const env = { ...base, ADMIN_AUTH_V2: "1", TRUST_ACCESS_HEADER: "1" };
  const res = await get("/blocks", env, { "cf-access-authenticated-user-email": "owner@example.com" });
  assert.equal(res.status, 200, await res.clone().text());
});

test("admin-auth v2 OFF: legacy Access-header behaviour is unchanged", async () => {
  const res = await get("/blocks", base, { "cf-access-authenticated-user-email": "owner@example.com" });
  assert.equal(res.status, 200);
  assert.equal((await get("/blocks", base)).status, 401);
});

test("a staff session is refused here (403): staff use the row-scoped /admin-v2 routes", async () => {
  const st = await signIn("staff", "staff");
  const res = await get("/blocks", v2, { cookie: st.cookie });
  assert.equal(res.status, 403);
});

test("a revoked session is refused (401)", async () => {
  const a = await signIn("revoked", "admin");
  assert.equal((await get("/blocks", v2, { cookie: a.cookie })).status, 200);
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id = ${a.u.id}::uuid`);
  assert.equal((await get("/blocks", v2, { cookie: a.cookie })).status, 401);
});

test("ADMIN_OPERATORS still narrows who may use it", async () => {
  const a = await signIn("allow", "admin");
  const env = { ...base, ADMIN_AUTH_V2: "1", ADMIN_OPERATORS: "someone.else@example.com" };
  assert.equal((await get("/blocks", env, { cookie: a.cookie })).status, 403);
  const ok = { ...base, ADMIN_AUTH_V2: "1", ADMIN_OPERATORS: a.u.email };
  assert.equal((await get("/blocks", ok, { cookie: a.cookie })).status, 200);
});

test("CSRF: a cookie-authenticated WRITE needs Origin == Host; reads do not", async () => {
  const a = await signIn("csrf", "admin");
  const write = (headers: Record<string, string>) => app.request("http://localhost/deploy-trigger", {
    method: "POST", body: "{}",
    headers: { host: "localhost", "content-type": "application/json", "cf-connecting-ip": ip(), cookie: a.cookie, ...headers },
  }, v2 as never);
  assert.equal((await write({})).status, 403, "no Origin");
  assert.equal((await write({ origin: "https://evil.example" })).status, 403, "foreign Origin");
  const same = await write({ origin: "http://localhost" });
  assert.notEqual(same.status, 401);
  assert.notEqual(same.status, 403, "same-site writes get past authentication (the route itself may still refuse the call)");
});
