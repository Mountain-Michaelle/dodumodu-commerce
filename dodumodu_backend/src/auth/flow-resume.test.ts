// Reload / reopened-tab resume, lost-email recovery and the admin review queue, through the
// real HTTP routes (live DB; fails fast without DATABASE_URL, refuses non-local databases).
//   * GET /auth/status lands the browser on its CURRENT stage for 180 s after the last
//     completed step (the boundary is pinned at 170 s in / 181 s out), never leaks the full email
//   * done / dead / expired / cookie-less flows are not resumable
//   * a reload on the shown-once backup-codes step re-issues a fresh set (old one revoked)
//   * lost-email: uniform 202 for known/unknown/malformed, one admin bell entry + one queue row
//     per 24 h, throttled per IP, and the admin queue can resolve it
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { authRoute, adminRoute } from "./routes";
import { q, q1, sql } from "./sql";
import { notificationService } from "../services/notificationService";
import { setPrimaryUser } from "./admin-ops";
import { FLOW_STEP_RESUME_SECS } from "./config";
import {
  openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag,
  createEnrolledUser, newTotpFlow, createActiveDevice,
} from "./mfa-test-kit";
import { tokenHashHex } from "./keys";
import { randomToken } from "./crypto";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("resume");
const env = {
  DATABASE_URL: process.env.DATABASE_URL!, ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
} as never;
const app = new Hono();
app.route("/auth", authRoute as never);
app.route("/admin-v2", adminRoute as never);

let primary: { id: string; email: string };
let prevPrimary: string | null = null;
let ipN = 0;
// Random /16 per run: throttle rows from earlier runs are keyed by IP and would bleed in.
const base = [1 + Math.floor(Math.random() * 200), Math.floor(Math.random() * 250)];
const nextIp = () => `10.${base[0]}.${(base[1] + Math.floor(ipN / 250)) % 250}.${(ipN++ % 250) + 1}`;

before(async () => {
  const prev = await q1<{ id: string }>(db, sql`SELECT id::text AS id FROM aa_users WHERE is_primary`);
  prevPrimary = prev?.id ?? null;
  await q(db, sql`UPDATE aa_users SET is_primary = false WHERE is_primary`);
  const u = await createEnrolledUser(db, s, `${tag}-primary@example.com`, { role: "admin" });
  await setPrimaryUser(db, u.id);
  primary = { id: u.id, email: u.email };
});

after(async () => {
  await q(db, sql`DELETE FROM aa_account_requests WHERE username_attempted LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM admin_notifications WHERE body LIKE ${"%" + tag + "%"}`);
  await q(db, sql`UPDATE aa_users SET is_primary = false WHERE email LIKE ${tag + "%"}`);
  if (prevPrimary) await q(db, sql`UPDATE aa_users SET is_primary = true WHERE id = ${prevPrimary}::uuid`).catch(() => {});
  await cleanupTag(db, tag);
  await closePools();
});

const hdr = (ip: string, cookie = "") => ({
  "content-type": "application/json", host: "localhost", origin: "http://localhost",
  "cf-connecting-ip": ip, "x-test-ip": ip, cookie,
});
const get = (path: string, cookie = "", ip = nextIp()) =>
  app.request(`http://localhost${path}`, { method: "GET", headers: hdr(ip, cookie) }, env);
const post = (path: string, body: unknown, cookie = "", ip = nextIp()) =>
  app.request(`http://localhost${path}`, { method: "POST", headers: hdr(ip, cookie), body: JSON.stringify(body) }, env);

async function flowAt(stage: string, ageSecs = 0) {
  const u = await createEnrolledUser(db, s, `${tag}-u${Math.random().toString(36).slice(2, 8)}@example.com`);
  const f = await newTotpFlow(db, s, u, { vid: newVid(), stage });
  await q(db, sql`UPDATE aa_auth_flows SET last_step_at = now() - (${ageSecs}::int * interval '1 second') WHERE id = ${f.id}::uuid`);
  return { u, f, cookie: `__Host-aaf=${f.token}` };
}

test("the resume window is 180 seconds (3 minutes)", () => {
  assert.equal(FLOW_STEP_RESUME_SECS, 180);
});

test("a reload lands on the CURRENT stage, for every stage the user can be on", async () => {
  for (const stage of ["otp", "totp", "totp_enroll", "backup_codes", "ready"]) {
    const { u, cookie } = await flowAt(stage);
    const res = await get("/auth/status", cookie);
    assert.equal(res.status, 200, stage);
    const j = await res.json() as { stage: string; email_masked: string; expires_in: number };
    assert.equal(j.stage, stage);
    assert.notEqual(j.email_masked, u.email, "the full email is never returned");
    assert.ok(j.email_masked.includes("@") && j.email_masked.includes("*"), j.email_masked);
    assert.ok(j.expires_in > 0 && j.expires_in <= 180, `expires_in ${j.expires_in}`);
  }
});

test("window boundary: 170 s after the last step resumes, 181 s does not", async () => {
  const inside = await flowAt("totp", 170);
  const ok = await get("/auth/status", inside.cookie);
  assert.equal(ok.status, 200);
  const left = (await ok.json() as { expires_in: number }).expires_in;
  assert.ok(left >= 1 && left <= 10, `about 10 s left, got ${left}`);

  const outside = await flowAt("totp", 181);
  assert.equal((await get("/auth/status", outside.cookie)).status, 404);
});

test("not resumable: no cookie, unknown cookie, done, dead, or an expired flow", async () => {
  assert.equal((await get("/auth/status")).status, 404);
  assert.equal((await get("/auth/status", "__Host-aaf=not-a-real-flow")).status, 404);
  for (const stage of ["done", "dead"]) {
    const { cookie } = await flowAt(stage);
    assert.equal((await get("/auth/status", cookie)).status, 404, stage);
  }
  const expired = await flowAt("totp");
  await q(db, sql`UPDATE aa_auth_flows SET expires_at = now() - interval '1 second' WHERE id = ${expired.f.id}::uuid`);
  assert.equal((await get("/auth/status", expired.cookie)).status, 404);
});

test("a completed step restarts the window (an old flow resumes again after reissue)", async () => {
  const { cookie, f } = await flowAt("backup_codes", 175);
  assert.equal((await post("/auth/backup-codes/reissue", {}, cookie)).status, 200);
  const age = await q1<{ age: number }>(db, sql`
    SELECT floor(extract(epoch FROM (now() - last_step_at)))::int AS age FROM aa_auth_flows WHERE id = ${f.id}::uuid`);
  assert.ok(age!.age <= 2, `last_step_at refreshed (age ${age!.age}s)`);
});

test("reload on the backup-codes step: fresh codes are issued, the old unacknowledged set is revoked, ack still works", async () => {
  const { u, cookie } = await flowAt("backup_codes");
  await q(db, sql`INSERT INTO aa_backup_code_sets (user_id, generation) VALUES (${u.id}::uuid, 90)`);
  const first = await post("/auth/backup-codes/reissue", {}, cookie);
  assert.equal(first.status, 200);
  const a = (await first.json() as { backup_codes: string[] }).backup_codes;
  assert.equal(a.length, 8);
  const second = await post("/auth/backup-codes/reissue", {}, cookie);
  const b = (await second.json() as { backup_codes: string[] }).backup_codes;
  assert.notDeepEqual(a, b);
  const live = await q1<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM aa_backup_code_sets
     WHERE user_id = ${u.id}::uuid AND revoked_at IS NULL AND acked_at IS NULL`);
  assert.equal(live!.n, 1, "exactly one live unacknowledged set: what the user is looking at");
  const ack = await post("/auth/backup-codes/ack", {}, cookie);
  assert.equal(ack.status, 200);
  assert.equal(((await ack.json()) as { next: string }).next, "ready");
});

test("reissue is only possible on the backup-codes step", async () => {
  for (const stage of ["otp", "totp", "totp_enroll", "ready"]) {
    const { cookie } = await flowAt(stage);
    assert.equal((await post("/auth/backup-codes/reissue", {}, cookie)).status, 401, stage);
  }
  assert.equal((await post("/auth/backup-codes/reissue", {})).status, 401);
});

test("lost email: identical 202 for a real account, an unknown handle and garbage", async () => {
  const real = await createEnrolledUser(db, s, `${tag}-lostreal@example.com`);
  const bodies = [{ username: real.email }, { username: `${tag}-nobody@example.com` }, { username: "" }, {}];
  const out: string[] = [];
  for (const b of bodies) {
    const r = await post("/auth/lost-email", b, "", nextIp());
    out.push(`${r.status} ${await r.text()}`);
  }
  assert.equal(new Set(out).size, 1, `all answers identical: ${JSON.stringify(out)}`);
  assert.match(out[0], /^202 /);
});

test("lost email: a real account creates ONE queue row and ONE admin bell entry per 24 h", async () => {
  const real = await createEnrolledUser(db, s, `${tag}-lostbell@example.com`);
  for (let i = 0; i < 2; i++) assert.equal((await post("/auth/lost-email", { username: real.email }, "", nextIp())).status, 202);
  const rows = await q<{ id: string }>(db, sql`SELECT id::text AS id FROM aa_account_requests
    WHERE username_attempted = ${real.email} AND status = 'open'`);
  assert.equal(rows.length, 1);
  const bell = (await notificationService.list(db, primary.id, 100))
    .filter((n) => n.type === "account_request" && n.body.includes(real.email));
  assert.equal(bell.length, 1);
});

test("lost email: an unknown handle creates no queue row and no bell entry", async () => {
  const ghost = `${tag}-ghost@example.com`;
  await post("/auth/lost-email", { username: ghost }, "", nextIp());
  const n = await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_account_requests WHERE username_attempted = ${ghost}`);
  assert.equal(n!.n, 0);
  assert.equal((await notificationService.list(db, primary.id, 100)).filter((x) => x.body.includes(ghost)).length, 0);
});

test("lost email is throttled per IP and the throttle answers the same for any input", async () => {
  const ip = nextIp();
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await post("/auth/lost-email", { username: `${tag}-spam${i}` }, "", ip)).status);
  assert.deepEqual(statuses.slice(0, 3), [202, 202, 202]);
  assert.ok(statuses.includes(429), `eventually 429: ${statuses}`);
});

async function adminCookie() {
  const admin = await createEnrolledUser(db, s, `${tag}-rev${Math.random().toString(36).slice(2, 6)}@example.com`, { role: "admin" });
  const devTok = await createActiveDevice(db, admin.id);
  const dev = (await q1<{ id: string }>(db, sql`
    SELECT id::text AS id FROM aa_admin_devices WHERE token_hash = decode(${await tokenHashHex(devTok)}, 'hex')`))!;
  const sid = randomToken();
  await q(db, sql`INSERT INTO aa_sessions
    (id_hash, user_id, session_version, absolute_expires_at, ip, ua, device_id, login_via, ip_prefix, country, tier, stepup_until)
    SELECT decode(${await tokenHashHex(sid)}, 'hex'), u.id, u.session_version, now() + interval '1 hour',
           '10.1.1.1', 'itest', ${dev.id}::uuid, 'device', '10.1.1', NULL, 'normal', now() + interval '1 hour'
      FROM aa_users u WHERE u.id = ${admin.id}::uuid`);
  return `__Host-sid=${sid}; __Host-vid=${newVid()}`;
}

test("admin queue: the request is listed, can be resolved, and then leaves the open list", async () => {
  const real = await createEnrolledUser(db, s, `${tag}-queue@example.com`);
  await post("/auth/lost-email", { username: real.email }, "", nextIp());
  const cookie = await adminCookie();
  const list = await app.request("http://localhost/admin-v2/account-requests", { headers: hdr(nextIp(), cookie) }, env);
  assert.equal(list.status, 200, await list.clone().text());
  const found = ((await list.json()) as { requests: { id: string; usernameAttempted: string }[] }).requests
    .find((r) => r.usernameAttempted === real.email);
  assert.ok(found, "listed");
  const res = await app.request(`http://localhost/admin-v2/account-requests/${found!.id}/resolve`, {
    method: "POST", headers: hdr(nextIp(), cookie), body: JSON.stringify({ action: "resolved" }) }, env);
  assert.equal(res.status, 200, await res.clone().text());
  const after = ((await (await app.request("http://localhost/admin-v2/account-requests", { headers: hdr(nextIp(), cookie) }, env)).json()) as
    { requests: { usernameAttempted: string }[] }).requests;
  assert.ok(!after.some((r) => r.usernameAttempted === real.email));
  assert.equal((await app.request("http://localhost/admin-v2/account-requests", { headers: hdr(nextIp()) }, env)).status, 401,
    "anonymous callers cannot read the queue");
});
