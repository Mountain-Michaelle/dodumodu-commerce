// The sign-in code email, end to end through the real routes with the REAL Resend provider
// (fetch stubbed at api.resend.com; ALLOW_TEST_IP is OFF, so nothing is captured in memory):
//   * a registered user gets exactly one email, to their address, with a code that logs them in
//   * a NEW browser (no device cookie) gets it too; an unknown/inactive account gets none
//   * a missing/empty RESEND_API_KEY or a rejecting provider is a VISIBLE server fault, never a
//     silent 202 that sent nothing
//   * a second request while the 3-minute code is alive does not send a duplicate
// Live DB; fails fast without DATABASE_URL and refuses non-local databases.
import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { authRoute } from "./routes";
import { q, sql } from "./sql";
import { openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser } from "./mfa-test-kit";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("lemail");
const realFetch = globalThis.fetch;
type Mail = { to: string; from: string; subject: string; text: string; key: string };
let mails: Mail[] = [];
let resendStatus = 200;
let resendBody = "{}";
const SENDER = "auth@verified.example.org";   // differs from the code default, so a missing `from` is caught

const baseEnv = {
  DATABASE_URL: process.env.DATABASE_URL!, ADMIN_AUTH_V2: "1",
  RESEND_API_KEY: "re_test_key", AUTH_FROM_EMAIL: SENDER,
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
};
const app = new Hono();
app.route("/auth", authRoute as never);

let ipN = 0;
const base = [1 + Math.floor(Math.random() * 200), Math.floor(Math.random() * 250)];
const nextIp = () => `10.${base[0]}.${(base[1] + Math.floor(ipN / 250)) % 250}.${(ipN++ % 250) + 1}`;

before(() => {
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    if (!String(i).includes("api.resend.com")) return realFetch(i, init);
    if (resendStatus !== 200) return new Response(resendBody, { status: resendStatus });
    const b = JSON.parse(String(init?.body));
    mails.push({ to: b.to, from: b.from, subject: b.subject, text: b.text, key: new Headers(init?.headers).get("Idempotency-Key") ?? "" });
    return new Response(JSON.stringify({ id: "m" }), { status: 200 });
  }) as typeof fetch;
});
beforeEach(() => { mails = []; resendStatus = 200; resendBody = "{}"; });
after(async () => { globalThis.fetch = realFetch; await cleanupTag(db, tag); await closePools(); });

const post = (path: string, body: unknown, ip: string, cookie = "", env: Record<string, string> = baseEnv) =>
  app.request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", "cf-connecting-ip": ip, cookie },
    body: JSON.stringify(body),
  }, env as never);
const cookieOf = (res: Response, name: string) =>
  ((res.headers as unknown as { getSetCookie(): string[] }).getSetCookie() ?? [])
    .map((c: string) => c.split(";")[0]).find((c: string) => c.startsWith(name + "=")) ?? "";
const codeIn = (m: Mail) => /code is ([^\s.]{10})/.exec(m.text)?.[1] ?? "";

test("a registered user receives ONE email at their address, and the code in it signs them in", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-ok@example.com`, { role: "admin" });
  const ip = nextIp();
  const res = await post("/auth/request", { email: u.email }, ip, `__Host-vid=${newVid()}`);
  assert.equal(res.status, 202);
  assert.equal(mails.length, 1, "exactly one email");
  assert.equal(mails[0].to, u.email);
  assert.match(mails[0].subject, /sign-in code/i);
  const code = codeIn(mails[0]);
  assert.equal(code.length, 10);
  const flow = cookieOf(res, "__Host-aaf");
  assert.ok(flow, "a flow cookie was set");
  const next = await post("/auth/code", { code }, ip, flow);
  assert.equal(next.status, 200, await next.clone().text());
  assert.equal(((await next.json()) as { next: string }).next, "totp");
});

test("a NEW browser (no device cookie, no vid) still gets the email", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-newbrowser@example.com`, { role: "admin" });
  assert.equal((await post("/auth/request", { email: u.email }, nextIp())).status, 202);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, u.email);
});

test("the email address is matched case-insensitively and trimmed", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-case@example.com`);
  assert.equal((await post("/auth/request", { email: `  ${u.email.toUpperCase()} ` }, nextIp())).status, 202);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, u.email);
});

test("an unknown address gets the same 202 and NO email", async () => {
  assert.equal((await post("/auth/request", { email: `${tag}-nobody@example.com` }, nextIp())).status, 202);
  assert.equal(mails.length, 0);
});

test("an inactive account gets the same 202 and NO email", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-inactive@example.com`);
  await q(db, sql`UPDATE aa_users SET is_active = false WHERE id = ${u.id}::uuid`);
  assert.equal((await post("/auth/request", { email: u.email }, nextIp())).status, 202);
  assert.equal(mails.length, 0);
});

test("typing the email again issues a NEW code (old one dies); /resend inside the cooldown sends nothing extra", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-again@example.com`);
  const ip = nextIp();
  const browser = `__Host-vid=${newVid()}`;                       // one browser: it keeps its vid cookie
  const r1 = await post("/auth/request", { email: u.email }, ip, browser);
  const r2 = await post("/auth/request", { email: u.email }, ip, browser);
  assert.equal(r2.status, 202);
  assert.equal(mails.length, 2, "a fresh request is a fresh email");
  const [c1, c2] = [codeIn(mails[0]), codeIn(mails[1])];
  assert.notEqual(c1, c2);
  const flow2 = cookieOf(r2, "__Host-aaf");
  assert.equal((await post("/auth/code", { code: c1 }, ip, flow2)).status, 401, "the superseded code is dead");
  assert.equal((await post("/auth/code", { code: c2 }, ip, flow2)).status, 200);
  void r1;

  const v = await createEnrolledUser(db, s, `${tag}-cool@example.com`);
  mails = [];
  const rq = await post("/auth/request", { email: v.email }, ip);
  assert.equal(mails.length, 1);
  // no vid cookie is sent on the resend: it still continues THIS flow's code (the flow remembers its browser)
  const rs = await post("/auth/resend", {}, ip, cookieOf(rq, "__Host-aaf"));
  assert.equal(rs.status, 202);
  assert.equal(mails.length, 1, "inside the 45 s cooldown no second email goes out");
});

for (const missing of ["", "   "]) {
  test(`RESEND_API_KEY ${JSON.stringify(missing)}: a visible server fault, never a silent 'sent'`, async () => {
    const u = await createEnrolledUser(db, s, `${tag}-nokey${missing.length}@example.com`);
    const res = await post("/auth/request", { email: u.email }, nextIp(), "", { ...baseEnv, RESEND_API_KEY: missing });
    assert.ok(res.status >= 500, `got ${res.status}`);
    assert.equal(mails.length, 0);
  });
}

test("an unset RESEND_API_KEY (undefined) is also a visible server fault", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-undef@example.com`);
  const { RESEND_API_KEY: _drop, ...noKey } = baseEnv;
  const res = await post("/auth/request", { email: u.email }, nextIp(), "", noKey);
  assert.ok(res.status >= 500, `got ${res.status}`);
});

test("a provider that rejects delivery (403/500) is a visible server fault too", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-reject@example.com`);
  resendStatus = 403;
  const res = await post("/auth/request", { email: u.email }, nextIp());
  assert.ok(res.status >= 500, `got ${res.status}`);
});

test("/resend after the cooldown re-sends the SAME code (the first email stays valid)", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-resend@example.com`);
  const ip = nextIp();
  const rq = await post("/auth/request", { email: u.email }, ip);
  const flow = cookieOf(rq, "__Host-aaf");
  await q(db, sql`UPDATE aa_login_challenges SET last_sent_at = now() - interval '50 seconds' WHERE user_id = ${u.id}::uuid`);
  assert.equal((await post("/auth/resend", {}, ip, flow)).status, 202);
  assert.equal(mails.length, 2);
  assert.equal(codeIn(mails[0]), codeIn(mails[1]), "same code both times");
  assert.equal((await post("/auth/code", { code: codeIn(mails[0]) }, ip, flow)).status, 200);
});

const waitForMail = async (n: number) => {
  for (let i = 0; i < 100 && mails.length < n; i++) await new Promise((r) => setTimeout(r, 20));
};

test("every email type is sent FROM the configured sender (AUTH_FROM_EMAIL), never the code default", async () => {
  // 1. the sign-in code
  const u = await createEnrolledUser(db, s, `${tag}-from@example.com`, { role: "admin" });
  assert.equal((await post("/auth/request", { email: u.email }, nextIp(), `__Host-vid=${newVid()}`)).status, 202);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].from, SENDER);

  // 2. the "someone probed your admin address" alert: an active admin with no authenticator and no open window
  mails = [];
  const denied = `${tag}-denied@example.com`;
  await q(db, sql`INSERT INTO aa_users (email, role) VALUES (${denied}, 'admin')`);
  assert.equal((await post("/auth/request", { email: denied }, nextIp())).status, 202);
  await waitForMail(1);
  assert.equal(mails.length, 1, "the denied-sign-in alert was sent");
  assert.match(mails[0].subject, /unrecognized device/i);
  assert.equal(mails[0].from, SENDER);

  // 3. the lost-email recovery alert
  mails = [];
  const handle = `${tag}-handle`;
  await q(db, sql`INSERT INTO aa_users (email, username, role) VALUES (${`${tag}-lost@example.com`}, ${handle}, 'staff')`);
  try {
    assert.equal((await post("/auth/lost-email", { username: handle }, nextIp())).status, 202);
    await waitForMail(1);
    assert.equal(mails.length, 1, "the recovery alert was sent");
    assert.match(mails[0].subject, /recovery/i);
    assert.equal(mails[0].from, SENDER);
  } finally {
    await q(db, sql`DELETE FROM aa_account_requests WHERE username_attempted = ${handle}`);
  }
});

test("a provider refusal is LOGGED with its status and reason, and none of it reaches the client", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-logged@example.com`, { role: "admin" });
  resendStatus = 403;
  resendBody = JSON.stringify({ message: "The example.org domain is not verified for re_secretkey123456" });
  const lines: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  let res: Response;
  try {
    res = await post("/auth/request", { email: u.email }, nextIp(), `__Host-vid=${newVid()}`);
  } finally {
    console.error = realErr;
  }
  assert.equal(res.status, 503);
  const body = await res.text();
  const log = lines.find((l) => l.includes("email_provider_failure"));
  assert.ok(log, "the failure is in the server log");
  assert.match(log!, /"status":403/);
  assert.match(log!, /not verified/);
  assert.doesNotMatch(log!, /re_secretkey123456/, "keys are scrubbed from logs");
  assert.doesNotMatch(log!, new RegExp(u.email.replace(/[.+]/g, "\\$&")), "addresses are scrubbed from logs");
  assert.doesNotMatch(body, /verified|403|re_secret|provider/i, "nothing about the provider reaches the client");
});
