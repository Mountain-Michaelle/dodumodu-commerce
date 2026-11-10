// Administrator views of sessions + devices (all users, owner shown, searched/paged on the server) and the
// per-user revokes behind the users page. Live DB; fails fast without DATABASE_URL, refuses non-local DBs.
//   * every row names its user (id + email); search matches email / user id / session id / device id / label / ip
//   * wildcards in a search are literal; paging reports the true total
//   * only LIVE sessions are listed (expired, revoked, version-bumped ones never appear)
//   * non-admins are refused (403), anonymous is 401 — on every route
//   * revokes need a fresh step-up, target the exact (user, record) pair, and never touch another user's record
//   * revoking a device ends its sessions; "revoke all" on yourself keeps the session you are using
//   * REGRESSION: /admin-v2/users?q= answered 500 (search clause without WHERE) unless a filter was also given
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { authRoute, adminRoute } from "./routes";
import { q, q1, sql } from "./sql";
import {
  openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow,
} from "./mfa-test-kit";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("alist");
const env = {
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "sandbox", ALLOW_TEST_IP: "1", ADMIN_AUTH_V2: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
} as never;
const app = new Hono();
app.route("/auth", authRoute as never);
app.route("/admin-v2", adminRoute as never);
after(async () => { await cleanupTag(db, tag); await closePools(); });

let n = 0;
const ip = () => `10.98.${Math.floor(n / 250) + 1}.${(n++ % 250) + 1}`;

async function signIn(label: string, role: "admin" | "staff" = "admin") {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role });
  await q(db, sql`UPDATE aa_users SET device_window_until = now() + interval '1 hour' WHERE id = ${u.id}::uuid`);
  const vid = newVid(), addr = ip();
  const f = await newTotpFlow(db, s, u, { vid, stage: "ready" });
  const res = await app.request("http://localhost/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost",
      "cf-connecting-ip": addr, "x-test-ip": addr, "user-agent": `UA-${label}`, cookie: `__Host-aaf=${f.token}; __Host-vid=${vid}` },
    body: "{}",
  }, env);
  assert.equal(res.status, 200, await res.text());
  const sc = res.headers.get("set-cookie") ?? "";
  const sid = /__Host-sid=([^;]+)/.exec(sc)![1];
  const did = /__Host-did=([^;]+)/.exec(sc)?.[1];
  const row = await q1<{ sid: string }>(db, sql`SELECT sid::text AS sid FROM aa_sessions WHERE user_id = ${u.id}::uuid ORDER BY created_at DESC LIMIT 1`);
  const dev = await q1<{ id: string }>(db, sql`SELECT id::text AS id FROM aa_admin_devices WHERE user_id = ${u.id}::uuid ORDER BY created_at DESC LIMIT 1`);
  return { u, sid: row!.sid, deviceId: dev?.id ?? null, label,
    cookie: `__Host-sid=${sid}${did ? `; __Host-did=${did}` : ""}; __Host-vid=${vid}` };
}
type Who = Awaited<ReturnType<typeof signIn>>;

const call = (method: string, path: string, cookie?: string, body?: unknown) => {
  const addr = ip();
  return app.request(`http://localhost${path}`, {
    method,
    headers: { host: "localhost", origin: "http://localhost", "cf-connecting-ip": addr, "x-test-ip": addr,
      ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  }, env);
};
const stepUp = (w: Who) => q(db, sql`UPDATE aa_sessions SET stepup_until = now() + interval '10 minutes' WHERE user_id = ${w.u.id}::uuid`);
const liveSessions = async (userId: string) =>
  (await q<{ sid: string }>(db, sql`SELECT sid::text AS sid FROM aa_sessions WHERE user_id = ${userId}::uuid`)).map((r) => r.sid);

let admin: Who, other: Who, staff: Who;
test("setup: an administrator, another administrator and a staff member, all signed in", async () => {
  admin = await signIn("admin"); other = await signIn("zeta"); staff = await signIn("staff", "staff");
  await q(db, sql`UPDATE aa_admin_devices SET label = 'Zeta Pixel Phone' WHERE id = ${other.deviceId}::uuid`);
});

test("sessions: every row names its user; the list covers everyone; own session is flagged", async () => {
  const res = await call("GET", `/admin-v2/sessions?q=${tag}&limit=100`, admin.cookie);
  assert.equal(res.status, 200);
  const body = await res.json() as { sessions: Array<Record<string, unknown>>; total: number };
  assert.ok(body.total >= 3);
  const mine = body.sessions.find((r) => r.user_id === admin.u.id)!;
  assert.equal(mine.user_email, `${tag}-admin@example.com`);
  assert.equal(mine.current, true);
  assert.equal(mine.sid, admin.sid);
  const theirs = body.sessions.find((r) => r.user_id === other.u.id)!;
  assert.equal(theirs.current, false);
  assert.equal(theirs.device_label, "Zeta Pixel Phone");
  assert.equal(theirs.ua, "UA-zeta");
});

test("sessions: search by email, user id, session id, device label and user agent; wildcards are literal", async () => {
  const find = async (term: string) => (await (await call("GET", `/admin-v2/sessions?q=${encodeURIComponent(term)}`, admin.cookie)).json() as { sessions: Array<{ user_id: string }>; total: number });
  assert.deepEqual((await find(`${tag}-zeta`)).sessions.map((r) => r.user_id), [other.u.id]);
  assert.deepEqual((await find(other.u.id)).sessions.map((r) => r.user_id), [other.u.id]);
  assert.deepEqual((await find(other.sid.slice(0, 13))).sessions.map((r) => r.user_id), [other.u.id]);
  assert.deepEqual((await find("zeta pixel")).sessions.map((r) => r.user_id), [other.u.id]);
  assert.deepEqual((await find("UA-zeta")).sessions.map((r) => r.user_id), [other.u.id]);
  assert.equal((await find("%")).total, 0, "% is not a wildcard");
  assert.equal((await find("_")).total, 0, "_ is not a wildcard");
  assert.equal((await find("no-such-thing-xyz")).total, 0);
});

test("sessions: paging returns the true total and distinct pages", async () => {
  const page = async (offset: number) => (await (await call("GET", `/admin-v2/sessions?q=${tag}&limit=1&offset=${offset}`, admin.cookie)).json() as { sessions: Array<{ sid: string }>; total: number; limit: number; offset: number });
  const a = await page(0), b = await page(1);
  assert.equal(a.sessions.length, 1); assert.equal(b.sessions.length, 1);
  assert.notEqual(a.sessions[0].sid, b.sessions[0].sid);
  assert.equal(a.total, b.total); assert.ok(a.total >= 3);
  assert.equal(a.limit, 1); assert.equal(b.offset, 1);
  const huge = await (await call("GET", `/admin-v2/sessions?q=${tag}&limit=100000`, admin.cookie)).json() as { limit: number };
  assert.equal(huge.limit, 100, "limit is clamped");
});

test("sessions: expired, version-bumped and revoked sessions are never listed", async () => {
  const exp = await signIn("expired"), ver = await signIn("version"), gone = await signIn("gone");
  const list = async () => (await (await call("GET", `/admin-v2/sessions?q=${tag}&limit=100`, admin.cookie)).json() as { sessions: Array<{ user_id: string }> }).sessions.map((r) => r.user_id);
  const before = await list();
  for (const w of [exp, ver, gone]) assert.ok(before.includes(w.u.id));
  await q(db, sql`UPDATE aa_sessions SET absolute_expires_at = now() - interval '1 minute' WHERE user_id = ${exp.u.id}::uuid`);
  await q(db, sql`UPDATE aa_users SET session_version = session_version + 1 WHERE id = ${ver.u.id}::uuid`);
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id = ${gone.u.id}::uuid`);
  const after = await list();
  for (const w of [exp, ver, gone]) assert.ok(!after.includes(w.u.id), `${w.label} must not be listed`);
});

test("authorization: staff get 403, anonymous gets 401, on every administrator list", async () => {
  const paths = ["/admin-v2/sessions", `/admin-v2/users/${other.u.id}/sessions`, `/admin-v2/users/${other.u.id}/devices`, "/admin-v2/devices?scope=all"];
  for (const p of paths) {
    assert.equal((await call("GET", p, staff.cookie)).status, 403, `staff ${p}`);
    assert.equal((await call("GET", p)).status, 401, `anonymous ${p}`);
  }
  assert.equal((await call("GET", "/admin-v2/users/not-a-uuid/sessions", admin.cookie)).status, 401, "malformed user id is rejected, not a 500");
});

test("per-user lists only contain that user's records", async () => {
  const sess = await (await call("GET", `/admin-v2/users/${other.u.id}/sessions`, admin.cookie)).json() as { sessions: Array<{ user_id: string }>; total: number };
  assert.equal(sess.total, 1); assert.ok(sess.sessions.every((r) => r.user_id === other.u.id));
  const dev = await (await call("GET", `/admin-v2/users/${other.u.id}/devices`, admin.cookie)).json() as { devices: Array<{ user_id: string; id: string; user_email: string }>; total: number };
  assert.equal(dev.total, 1); assert.equal(dev.devices[0].id, other.deviceId); assert.equal(dev.devices[0].user_email, `${tag}-zeta@example.com`);
});

test("devices (all owners): owner shown, search by email / device id / label, mine stays the default", async () => {
  const find = async (term: string) => (await (await call("GET", `/admin-v2/devices?scope=all&q=${encodeURIComponent(term)}`, admin.cookie)).json() as { devices: Array<{ id: string; user_id: string; live_sessions: number }>; total: number });
  const byMail = await find(`${tag}-zeta`);
  assert.deepEqual(byMail.devices.map((d) => d.id), [other.deviceId]);
  assert.equal(byMail.devices[0].user_id, other.u.id);
  assert.equal(byMail.devices[0].live_sessions, 1);
  assert.deepEqual((await find(other.deviceId!.slice(0, 12))).devices.map((d) => d.id), [other.deviceId]);
  assert.deepEqual((await find("pixel phone")).devices.map((d) => d.id), [other.deviceId]);
  assert.equal((await find("%")).total, 0);
  const mine = await (await call("GET", "/admin-v2/devices", admin.cookie)).json() as { user: { id: string; email: string }; devices: Array<{ id: string }> };
  assert.equal(mine.user.id, admin.u.id); assert.equal(mine.user.email, `${tag}-admin@example.com`);
  assert.deepEqual(mine.devices.map((d) => d.id), [admin.deviceId], "default view is still my own devices");
});

test("/auth/sessions names the signed-in user (additive field)", async () => {
  const res = await (await call("GET", "/auth/sessions", admin.cookie)).json() as { user: { id: string; email: string }; sessions: unknown[] };
  assert.equal(res.user.id, admin.u.id); assert.equal(res.user.email, `${tag}-admin@example.com`); assert.equal(res.sessions.length, 1);
});

test("revoke one session: needs a fresh step-up; exact (user, session) pair; own session refused", async () => {
  const victim = await signIn("victim");
  const path = `/admin-v2/users/${victim.u.id}/sessions/${victim.sid}`;
  await q(db, sql`UPDATE aa_sessions SET stepup_until = NULL WHERE user_id = ${admin.u.id}::uuid`);
  assert.equal((await call("DELETE", path, admin.cookie)).status, 403, "no step-up");
  assert.deepEqual(await liveSessions(victim.u.id), [victim.sid], "nothing deleted without step-up");
  await stepUp(admin);
  assert.equal((await call("DELETE", `/admin-v2/users/${other.u.id}/sessions/${victim.sid}`, admin.cookie)).status, 401, "a session id paired with the WRONG user touches nothing");
  assert.deepEqual(await liveSessions(victim.u.id), [victim.sid]);
  assert.equal((await call("DELETE", `/admin-v2/users/${victim.u.id}/sessions/not-a-uuid`, admin.cookie)).status, 401);
  assert.equal((await call("DELETE", `/admin-v2/users/${admin.u.id}/sessions/${admin.sid}`, admin.cookie)).status, 403, "your own session: use sign out");
  assert.equal((await call("DELETE", path, staff.cookie)).status, 403, "staff cannot revoke");
  assert.equal((await call("DELETE", path, admin.cookie)).status, 200);
  assert.deepEqual(await liveSessions(victim.u.id), []);
  assert.equal((await call("GET", "/auth/sessions", victim.cookie)).status, 401, "the revoked person is signed out");
  assert.equal((await call("DELETE", path, admin.cookie)).status, 401, "repeat is rejected, not a false success");
});

test("revoke all sessions: others lose all, yourself keeps the current one; step-up required", async () => {
  const t1 = await signIn("bulk1");
  await q(db, sql`INSERT INTO aa_sessions (id_hash, user_id, session_version, absolute_expires_at, device_id)
    SELECT decode(md5(random()::text || ${tag}), 'hex'), user_id, session_version, absolute_expires_at, device_id FROM aa_sessions WHERE user_id = ${t1.u.id}::uuid`);
  assert.equal((await liveSessions(t1.u.id)).length, 2);
  await q(db, sql`UPDATE aa_sessions SET stepup_until = NULL WHERE user_id = ${admin.u.id}::uuid`);
  assert.equal((await call("POST", `/admin-v2/users/${t1.u.id}/sessions/revoke-all`, admin.cookie)).status, 403);
  assert.equal((await liveSessions(t1.u.id)).length, 2);
  await stepUp(admin);
  const res = await (await call("POST", `/admin-v2/users/${t1.u.id}/sessions/revoke-all`, admin.cookie)).json() as { revoked: number };
  assert.equal(res.revoked, 2); assert.deepEqual(await liveSessions(t1.u.id), []);
  const self = await (await call("POST", `/admin-v2/users/${admin.u.id}/sessions/revoke-all`, admin.cookie)).json() as { revoked: number };
  assert.equal(self.revoked, 0, "nothing else to end");
  assert.deepEqual(await liveSessions(admin.u.id), [admin.sid], "my own session survives");
});

test("revoke a device: right owner only, step-up required, its sessions end", async () => {
  const w = await signIn("devvictim");
  await q(db, sql`UPDATE aa_sessions SET stepup_until = NULL WHERE user_id = ${admin.u.id}::uuid`);
  const path = `/admin-v2/users/${w.u.id}/devices/${w.deviceId}`;
  assert.equal((await call("DELETE", path, admin.cookie)).status, 403, "no step-up");
  await stepUp(admin);
  assert.equal((await call("DELETE", `/admin-v2/users/${other.u.id}/devices/${w.deviceId}`, admin.cookie)).status, 401, "foreign pair rejected");
  assert.equal((await q1<{ status: string }>(db, sql`SELECT status FROM aa_admin_devices WHERE id = ${w.deviceId}::uuid`))!.status, "active");
  assert.equal((await call("DELETE", path, staff.cookie)).status, 403);
  assert.equal((await call("DELETE", path, admin.cookie)).status, 200);
  assert.equal((await q1<{ status: string }>(db, sql`SELECT status FROM aa_admin_devices WHERE id = ${w.deviceId}::uuid`))!.status, "revoked");
  assert.equal((await call("GET", "/auth/sessions", w.cookie)).status, 401, "its session ended with the device");
  const listed = await (await call("GET", `/admin-v2/devices?scope=all&q=${tag}-devvictim`, admin.cookie)).json() as { total: number };
  assert.equal(listed.total, 0, "revoked devices are not listed");
});

test("users list: search works with NO other filter (the 500 regression), with role, literally, and pages", async () => {
  const get = async (qs: string) => { const r = await call("GET", `/admin-v2/users?${qs}`, admin.cookie); assert.equal(r.status, 200, await r.clone().text()); return r.json() as Promise<{ users: Array<{ id: string; email: string }>; total: number }>; };
  const byMail = await get(`q=${tag}-zeta`);
  assert.deepEqual(byMail.users.map((u) => u.id), [other.u.id]); assert.equal(byMail.total, 1);
  assert.deepEqual((await get(`q=${other.u.id.slice(0, 8)}`)).users.map((u) => u.id), [other.u.id], "by user id prefix");
  assert.equal((await get(`q=${tag}-zeta&role=admin`)).total, 1);
  assert.equal((await get(`q=${tag}-zeta&role=mono`)).total, 0);
  assert.equal((await get("q=%25")).total, 0, "% is literal");
  const p1 = await get(`q=${tag}&limit=2&offset=0`), p2 = await get(`q=${tag}&limit=2&offset=2`);
  assert.equal(p1.users.length, 2); assert.ok(p1.total >= 4); assert.equal(p1.total, p2.total);
  assert.ok(p1.users.every((u) => !p2.users.some((v) => v.id === u.id)), "pages do not overlap");
  assert.equal((await get("")).users.length > 0, true, "unfiltered list returns users");
});

test("users list: a staff member without users.view is refused", async () => {
  assert.equal((await call("GET", "/admin-v2/users", staff.cookie)).status, 403);
  assert.equal((await call("GET", "/admin-v2/users")).status, 401);
});
