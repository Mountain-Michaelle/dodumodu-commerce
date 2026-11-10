// Device invitations, end to end through the REAL dispatcher (custom admin base path, production-like env).
//   * the link is built on a trusted origin + the admin base path, in dev and production; a client can never
//     steer it with Host / X-Forwarded-* / a forged internal header
//   * the link opens a static confirm page (GET redeems nothing); the token rides in the #fragment and is
//     posted in a body, so it never reaches a URL log
//   * redemption is atomic: one winner under concurrency, replay / expired / malformed / unknown are rejected
//   * only a step-up administrator can create one; staff and anonymous cannot; invites are bound to their user
//   * creation and redemption are rate limited
//   * the token is stored only as a hash
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { app as composed } from "../app";
import { q, q1, sql } from "./sql";
import { cleanOrigin, resolvePublicOrigin, inviteLink } from "./public-origin";
import { tokenHashHex } from "./keys";
import { INVITE_ACCEPT_PER_HOUR_IP, INVITE_CREATE_PER_HOUR } from "./config";
import {
  openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow,
} from "./mfa-test-kit";

const NS = "/4ehhi-5deggi";
const HOST = "shop.example.com";
const db = openTestDb();
const s = testSecrets();
const tag = makeTag("invite");
const baseEnv = {
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "production", ADMIN_BASE_PATH: NS, ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
  RATE_LIMIT_ADMIN_PER_MINUTE: "100000", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "100000",
  RATE_LIMIT_KV: { get: async () => null, put: async () => undefined },
};
const env = baseEnv as never;
after(async () => {
  // invites created BY a test administrator for another user reference that administrator: clear them first
  await q(db, sql`DELETE FROM aa_device_invites WHERE created_by IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await cleanupTag(db, tag); await closePools();
});

// networks are fresh per run: the per-network caps keep their counters for an hour
const NET = 1 + Math.floor(Math.random() * 200), NET2 = 1 + Math.floor(Math.random() * 200);
let n = 0;
const ip = () => `10.${NET}.${NET2 + Math.floor(n / 250)}.${(n++ % 250) + 1}`;

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string; headers?: Record<string, string>; ip?: string; e?: unknown } = {}) {
  const origin = opts.origin ?? `https://${HOST}`;
  const host = new URL(origin).host;
  const addr = opts.ip ?? ip();
  return composed.fetch(new Request(`${origin}${NS}${path}`, {
    method,
    headers: { host, origin, "cf-connecting-ip": addr, "x-test-ip": addr,
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
    body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
  }), (opts.e ?? env) as never);
}

async function signIn(label: string, role: "admin" | "staff" = "admin") {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role });
  await q(db, sql`UPDATE aa_users SET device_window_until = now() + interval '1 hour' WHERE id = ${u.id}::uuid`);
  const vid = newVid();
  const f = await newTotpFlow(db, s, u, { vid, stage: "ready" });
  const res = await req("POST", "/auth/session", { cookie: `__Host-aaf=${f.token}; __Host-vid=${vid}`, headers: { "user-agent": `UA-${label}` } });
  assert.equal(res.status, 200, await res.text());
  const sc = res.headers.get("set-cookie") ?? "";
  const sid = /__Host-sid=([^;]+)/.exec(sc)![1];
  const did = /__Host-did=([^;]+)/.exec(sc)?.[1];
  return { u, cookie: `__Host-sid=${sid}${did ? `; __Host-did=${did}` : ""}; __Host-vid=${vid}` };
}
type Who = Awaited<ReturnType<typeof signIn>>;
const stepUp = (w: Who) => q(db, sql`UPDATE aa_sessions SET stepup_until = now() + interval '10 minutes' WHERE user_id = ${w.u.id}::uuid`);
const tokenOf = (url: string) => decodeURIComponent(url.split("#")[1]);
async function createInvite(w: Who, path = "/admin-v2/devices/invite", o: Parameters<typeof req>[2] = {}) {
  const res = await req("POST", path, { cookie: w.cookie, ...o });
  return { res, url: res.status === 200 ? ((await res.json()) as { invite_url: string }).invite_url : "" };
}
const accept = (token: unknown, o: Parameters<typeof req>[2] = {}) => req("POST", "/auth/device/accept", { body: { token }, ...o });

// ---- pure origin rules ----
test("origin rules: configured wins; https only (http only on localhost); http upgraded off-localhost; junk rejected", () => {
  assert.equal(cleanOrigin("https://shop.example.com/some/path?x=1"), "https://shop.example.com");
  assert.equal(cleanOrigin("http://localhost:8787"), "http://localhost:8787");
  assert.equal(cleanOrigin("http://shop.example.com"), null, "plain http is not a public origin");
  assert.equal(cleanOrigin("javascript:alert(1)"), null);
  assert.equal(cleanOrigin("https://user:pw@shop.example.com"), null, "no credentials in an origin");
  assert.equal(cleanOrigin(""), null); assert.equal(cleanOrigin(undefined), null); assert.equal(cleanOrigin("not a url"), null);
  assert.equal(resolvePublicOrigin("https://admin.example.com", "https://x.workers.dev"), "https://admin.example.com");
  assert.equal(resolvePublicOrigin("garbage", "https://x.workers.dev"), "https://x.workers.dev", "bad config falls back to the request origin");
  assert.equal(resolvePublicOrigin(undefined, "http://shop.example.com"), "https://shop.example.com", "http upgraded");
  assert.equal(resolvePublicOrigin(undefined, "http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(resolvePublicOrigin(undefined, null), null);
  assert.equal(inviteLink({ ENVIRONMENT: "production", ADMIN_BASE_PATH: NS }, "https://shop.example.com", "T0KEN"), `https://shop.example.com${NS}/device/accept/#T0KEN`);
  assert.equal(inviteLink({}, null, "T"), null);
});

let admin: Who, staff: Who;
test("setup", async () => { admin = await signIn("admin"); staff = await signIn("staff", "staff"); await stepUp(admin); });

test("production link: real origin + admin base path + fragment token; never localhost", async () => {
  const { res, url } = await createInvite(admin);
  assert.equal(res.status, 200);
  assert.match(url, new RegExp(`^https://${HOST.replace(".", "\\.")}${NS}/device/accept/#[A-Za-z0-9_-]{20,}$`));
  assert.ok(!/localhost/.test(url));
});

test("development link: http://localhost:<port> is kept as is", async () => {
  const { url } = await createInvite(admin, "/admin-v2/devices/invite", { origin: "http://localhost:8787", e: { ...baseEnv, ENVIRONMENT: "sandbox" } });
  assert.match(url, new RegExp(`^http://localhost:8787${NS}/device/accept/#`));
});

test("the link cannot be steered by Host / X-Forwarded-* / a forged internal header", async () => {
  const evil = { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", "x-admin-public-origin": "https://evil.example", forwarded: "host=evil.example" };
  const { url } = await createInvite(admin, "/admin-v2/devices/invite", { headers: evil });
  assert.ok(url.startsWith(`https://${HOST}${NS}/device/accept/#`), url);
  assert.ok(!url.includes("evil"));
});

test("ADMIN_PUBLIC_ORIGIN pins the origin (e.g. behind a preview URL)", async () => {
  const { url } = await createInvite(admin, "/admin-v2/devices/invite", { origin: "https://dodumodu-commerce.example.workers.dev", e: { ...baseEnv, ADMIN_PUBLIC_ORIGIN: "https://admin.example.com" } });
  assert.ok(url.startsWith(`https://admin.example.com${NS}/device/accept/#`), url);
});

test("the invite page is public, static, no-store, and a GET redeems nothing", async () => {
  const { url } = await createInvite(admin);
  const token = tokenOf(url);
  const page = await req("GET", "/device/accept/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page.headers.get("cache-control") ?? "", /no-store/);
  const html = await page.text();
  assert.ok(html.includes(`${NS}/assets/device-accept.js`), "script path follows the admin base path");
  assert.ok(!html.includes(token));
  assert.equal((await req("GET", "/device/accept")).status, 200);
  assert.equal((await req("GET", "/assets/device-accept.js")).status, 200);
  const used = await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_device_invites WHERE user_id = ${admin.u.id}::uuid AND used_at IS NOT NULL`);
  assert.equal(used!.n, 0, "opening the page used no invite");
});

test("redeem: pending device for the intended user, cookie set, invite spent, replay rejected", async () => {
  const w = await signIn("redeem"); await stepUp(w);
  const { url } = await createInvite(w); const token = tokenOf(url);
  const before = (await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_admin_devices WHERE user_id = ${w.u.id}::uuid`))!.n;
  const res = await accept(token);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") ?? "", /__Host-did=/);
  const { device_id } = await res.json() as { device_id: string };
  const dev = await q1<{ user_id: string; status: string; created_via: string; pending: boolean; ok_exp: boolean }>(db,
    sql`SELECT user_id::text, status, created_via, pending_until > now() AS pending, expires_at > now() AS ok_exp FROM aa_admin_devices WHERE id = ${device_id}::uuid`);
  assert.deepEqual(dev, { user_id: w.u.id, status: "pending", created_via: "invite", pending: true, ok_exp: true });
  assert.equal((await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_admin_devices WHERE user_id = ${w.u.id}::uuid`))!.n, before + 1);
  assert.equal((await accept(token)).status, 401, "replay");
  assert.equal((await req("POST", `/auth/device/accept/${encodeURIComponent(token)}`)).status, 401, "replay through the path form too");
});

test("concurrent redemption: exactly one wins and exactly one device is created", async () => {
  const w = await signIn("race"); await stepUp(w);
  const { url } = await createInvite(w); const token = tokenOf(url);
  const before = (await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_admin_devices WHERE user_id = ${w.u.id}::uuid`))!.n;
  const results = await Promise.all(Array.from({ length: 8 }, () => accept(token)));
  const codes = results.map((r) => r.status).sort();
  assert.equal(codes.filter((c) => c === 200).length, 1, `statuses: ${codes}`);
  assert.equal(codes.filter((c) => c === 401).length, 7);
  assert.equal((await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_admin_devices WHERE user_id = ${w.u.id}::uuid`))!.n, before + 1);
});

test("expired, malformed, unknown and wrong-type tokens are rejected (401), never a 500", async () => {
  const w = await signIn("expire"); await stepUp(w);
  const { url } = await createInvite(w); const token = tokenOf(url);
  await q(db, sql`UPDATE aa_device_invites SET expires_at = now() - interval '1 second' WHERE user_id = ${w.u.id}::uuid`);
  const before = (await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_admin_devices WHERE user_id = ${w.u.id}::uuid`))!.n;
  assert.equal((await accept(token)).status, 401, "expired");
  for (const bad of ["", "x", "A".repeat(500), null, 123, { a: 1 }, ["t"]]) assert.equal((await accept(bad)).status, 401, JSON.stringify(bad)?.slice(0, 30));
  assert.equal((await req("POST", "/auth/device/accept", { body: "not-json-object" })).status, 401);
  assert.equal((await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_admin_devices WHERE user_id = ${w.u.id}::uuid`))!.n, before, "no device created");
});

test("creation is for step-up administrators only: staff, anonymous and no-step-up are refused", async () => {
  const w = await signIn("nostep");
  await q(db, sql`UPDATE aa_sessions SET stepup_until = NULL WHERE user_id = ${w.u.id}::uuid`);
  assert.equal((await req("POST", "/admin-v2/devices/invite", { cookie: w.cookie })).status, 403, "no step-up");
  assert.equal((await req("POST", "/admin-v2/devices/invite", { cookie: staff.cookie })).status, 403, "staff");
  assert.equal((await req("POST", "/admin-v2/devices/invite")).status, 401, "anonymous");
  assert.equal((await req("POST", `/admin-v2/users/${admin.u.id}/device-invite`, { cookie: staff.cookie })).status, 403);
  assert.equal((await req("POST", `/admin-v2/users/${admin.u.id}/device-invite`)).status, 401);
  assert.equal((await req("POST", "/admin-v2/devices/invite", { cookie: w.cookie, headers: { origin: "https://evil.example" } })).status, 403, "cross-site write");
});

test("an invite for ANOTHER administrator is bound to that user; self / staff / unknown targets are refused", async () => {
  const target = await signIn("target");
  const mk = (id: string) => req("POST", `/admin-v2/users/${id}/device-invite`, { cookie: admin.cookie });
  const res = await mk(target.u.id); assert.equal(res.status, 200);
  const token = tokenOf(((await res.json()) as { invite_url: string }).invite_url);
  const ok = await accept(token); assert.equal(ok.status, 200);
  const dev = await q1<{ user_id: string; created_via: string }>(db, sql`SELECT user_id::text, created_via FROM aa_admin_devices WHERE id = ${((await ok.json()) as { device_id: string }).device_id}::uuid`);
  assert.deepEqual(dev, { user_id: target.u.id, created_via: "admin_invite" });
  assert.equal((await mk(admin.u.id)).status, 401, "not for yourself through this route");
  assert.equal((await mk(staff.u.id)).status, 401, "not for staff");
  assert.equal((await mk("00000000-0000-0000-0000-000000000000")).status, 401, "unknown user");
});

test("the token is stored only as a hash and is not recoverable from the table", async () => {
  const w = await signIn("hash"); await stepUp(w);
  const { url } = await createInvite(w); const token = tokenOf(url);
  const row = await q1<{ h: string; dump: string }>(db, sql`SELECT encode(token_hash, 'hex') AS h, row_to_json(i)::text AS dump FROM aa_device_invites i WHERE user_id = ${w.u.id}::uuid`);
  assert.equal(row!.h, await tokenHashHex(token), "the stored value is the SHA-256 of the token");
  assert.equal(row!.h.length, 64); assert.notEqual(row!.h, token);
  assert.ok(!row!.dump.includes(token), "the raw token is nowhere in the row");
});

test("rate limits: redemption attempts per network, creations per administrator", async () => {
  const addr = ip();
  const codes: number[] = [];
  for (let i = 0; i < INVITE_ACCEPT_PER_HOUR_IP + 3; i++) codes.push((await accept(`bad-${i}`, { ip: addr })).status);
  assert.equal(codes.filter((c) => c === 401).length, INVITE_ACCEPT_PER_HOUR_IP, "the allowed number of tries are answered normally");
  assert.ok(codes.slice(INVITE_ACCEPT_PER_HOUR_IP).every((c) => c === 429), `over the cap -> 429: ${codes}`);
  // a real, valid invite from that same network is ALSO held back while it is over the cap
  const w = await signIn("cap"); await stepUp(w);
  const mk = await createInvite(w);
  assert.equal((await accept(tokenOf(mk.url), { ip: addr })).status, 429);
  assert.equal((await accept(tokenOf(mk.url))).status, 200, "from another network it still works");
  // creation cap
  const c = await signIn("capcreate"); await stepUp(c);
  const made: number[] = [];
  for (let i = 0; i < INVITE_CREATE_PER_HOUR + 2; i++) made.push((await req("POST", "/admin-v2/devices/invite", { cookie: c.cookie })).status);
  assert.equal(made.filter((x) => x === 200).length, INVITE_CREATE_PER_HOUR);
  assert.ok(made.slice(INVITE_CREATE_PER_HOUR).every((x) => x === 429), `${made}`);
});
