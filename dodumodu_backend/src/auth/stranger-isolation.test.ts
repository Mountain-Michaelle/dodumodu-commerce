// A stranger's activity - other browser, other network, or the same shared network - must never
// affect the REAL user: not their live session, not their trusted browser's login, not the code already
// in their inbox, and not their login from another browser or network.
// Audit findings this pins (all three were real before):
//   1. one emailed code per USER: any browser asking for a code replaced the one in the real user's inbox
//   2. one send allowance per EMAIL: a stranger spending it stopped codes on EVERY device for an hour
//   3. a network-level block (3 wrong attempts from a cookie-less stranger) also refused the trusted browser
// Plus: the stranger's own protections still bite (his browser is blocked, his network pair is throttled).
// Live DB; fails fast without DATABASE_URL and refuses non-local databases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { q, q1, sql } from "./sql";
import { requestCode, type EntrySecrets } from "./entry";
import { verifyCode } from "./factors";
import { verifyTotp } from "./totp-verify";
import { recordDeviceFailure } from "./device-failures";
import { finishAdminSession } from "./sessions-admin";
import { lookupSession } from "./session-lookup";
import { AuthLockedError, AuthRejectError } from "./errors";
import { OTP_SENDS_PER_HOUR } from "./config";
import {
  openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, createActiveDevice, newTotpFlow, codeFor,
} from "./mfa-test-kit";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("strang");
const secrets: EntrySecrets = { otpKey: s.otpKey, throttleKey: s.throttleKey };
const vsecrets = { otpKey: s.otpKey, throttleKey: s.throttleKey };
const net = 1 + Math.floor(Math.random() * 200);                       // random /16 per run: no throttle bleed
const ip = (a: number, b: number) => `10.${net}.${a}.${b}`;
const ctx = (addr: string) => ({ ip: addr, prefix: addr.split(".").slice(0, 3).join("."), country: "NG", ua: "stranger-test" });
after(async () => { await cleanupTag(db, tag); await closePools(); });

async function fixture(label: string) {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role: "admin" });
  const device = await createActiveDevice(db, u.id);
  const f = await newTotpFlow(db, s, u, { vid: newVid(), stage: "ready" });
  const sess = await finishAdminSession(db, { flowToken: f.token, ip: "10.0.0.1", ua: "a", prefix: "10.0.0", country: "NG", tier: "normal", deviceToken: device } as never);
  return { u, device, alive: async () => (await lookupSession(db, sess.sessionToken)) !== null };
}
const verifies = async (flowToken: string, code: string, addr: string) => {
  try { await verifyCode(db, vsecrets as never, flowToken, code, addr); return true; } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) return false;
    throw e;
  }
};

test("another browser asking for a code does NOT invalidate the code already in the real user's inbox", async () => {
  const { u, device, alive } = await fixture("inflight");
  const A = ip(1, 10), B = ip(2, 20);
  const vidA = newVid();
  const a = await requestCode(db, secrets, u.email, ctx(A), device, vidA);
  const b = await requestCode(db, secrets, u.email, ctx(B), null, newVid());      // stranger / another browser
  assert.ok(a.sendCode && b.sendCode);
  assert.notEqual(a.sendCode!.code, b.sendCode!.code, "each browser has its own code");
  assert.equal(await verifies(a.flowToken, a.sendCode!.code, A), true, "A's code still works");
  assert.equal(await alive(), true, "the live session is untouched");
});

test("a code is only good for the browser it was sent to", async () => {
  const { u } = await fixture("crosscode");
  const x = await requestCode(db, secrets, u.email, ctx(ip(3, 1)), null, newVid());
  const y = await requestCode(db, secrets, u.email, ctx(ip(3, 2)), null, newVid());
  assert.equal(await verifies(x.flowToken, y.sendCode!.code, ip(3, 1)), false, "another browser's code is refused");
  assert.equal(await verifies(x.flowToken, x.sendCode!.code, ip(3, 1)), true, "its own code is accepted");
});

test("a stranger exhausting sends from many networks cannot stop the real user's codes (trusted or another browser)", async () => {
  const { u, device, alive } = await fixture("flood");
  let strangerSent = 0;
  for (let i = 0; i < OTP_SENDS_PER_HOUR + 6; i++) {
    const r = await requestCode(db, secrets, u.email, ctx(ip(10 + (i % 200), 5 + Math.floor(i / 200))), null, newVid());
    if (r.sendCode) strangerSent++;
  }
  assert.ok(strangerSent > 0, "the stranger did send some");
  const trusted = await requestCode(db, secrets, u.email, ctx(ip(1, 11)), device, newVid());
  assert.ok(trusted.sendCode, "the TRUSTED browser still gets its code");
  const other = await requestCode(db, secrets, u.email, ctx(ip(1, 12)), null, newVid());
  assert.ok(other.sendCode, "the user's OTHER browser on another network still gets its code");
  assert.equal(await alive(), true);
});

test("a network block caused by a cookie-less stranger does not refuse the trusted browser on that network", async () => {
  const { u, device, alive } = await fixture("netblock");
  const A = ip(40, 10);
  const w = await newTotpFlow(db, s, u, { vid: null, stage: "otp" });          // ONE cookie-less flow, 3 wrong codes
  for (let i = 0; i < 3; i++) await recordDeviceFailure(db, s.throttleKey, w.id, A);
  const stranger = await requestCode(db, secrets, u.email, ctx(A), null, null);
  assert.equal(stranger.sendCode, null, "the stranger's network is blocked (his protection still bites)");
  const unrecognised = await requestCode(db, secrets, u.email, ctx(A), null, newVid());
  assert.equal(unrecognised.sendCode, null, "an unrecognised browser on the blocked network is blocked too");
  const trusted = await requestCode(db, secrets, u.email, ctx(A), device, newVid());
  assert.ok(trusted.sendCode, "the recognised trusted browser on the same network still logs in");
  assert.equal(await alive(), true);
});

test("a stranger's own browser block stays on that browser; the real user is unaffected", async () => {
  const { u, device, alive } = await fixture("devblock");
  const vS = newVid(), S = ip(50, 7);
  const w = await newTotpFlow(db, s, u, { vid: vS, stage: "otp" });            // the stranger's browser: 3 wrong codes
  for (let i = 0; i < 3; i++) await recordDeviceFailure(db, s.throttleKey, w.id, S);
  assert.equal((await requestCode(db, secrets, u.email, ctx(S), null, vS)).sendCode, null, "the stranger's browser is blocked");
  assert.ok((await requestCode(db, secrets, u.email, ctx(ip(50, 8)), device, newVid())).sendCode, "trusted browser fine");
  assert.ok((await requestCode(db, secrets, u.email, ctx(ip(50, 9)), null, newVid())).sendCode, "another browser fine");
  assert.equal(await alive(), true, "no session was touched");
});

test("a stranger on the SAME network exhausting the email+IP throttle cannot lock the trusted browser", async () => {
  const { u, device, alive } = await fixture("samenet");
  const A = ip(60, 10);
  let locked = false;
  for (let i = 0; i < 12 && !locked; i++) {
    try { await requestCode(db, secrets, u.email, ctx(A), null, newVid()); } catch (e) { if (e instanceof AuthLockedError) locked = true; else throw e; }
  }
  assert.equal(locked, true, "the stranger's email+IP pair does get throttled");
  const trusted = await requestCode(db, secrets, u.email, ctx(A), device, newVid());
  assert.ok(trusted.sendCode, "the trusted browser has its own bucket");
  assert.equal(await verifies(trusted.flowToken, trusted.sendCode!.code, A), true, "and can complete the code step");
  assert.equal(await alive(), true);
});

test("a stranger's wrong authenticator codes from the SAME network cannot lock the trusted browser's authenticator step", async () => {
  const u = await createEnrolledUser(db, s, `${tag}-totpnet@example.com`, { role: "admin" });
  const A = ip(90, 10), NOW = 1_800_000_000_000, step = Math.floor(NOW / 30000);
  let locked = false;
  for (let i = 0; i < 8 && !locked; i++) {                                   // stranger flows: 3 wrong codes each, same email + IP
    const f = await newTotpFlow(db, s, u, { vid: newVid(), stage: "totp" });
    for (let k = 0; k < 3 && !locked; k++) {
      try { await verifyTotp(db, s as never, f.token, { code: "000000" }, A, true, NOW); } catch (e) {
        if (e instanceof AuthLockedError) locked = true; else if (!(e instanceof AuthRejectError)) throw e;
      }
    }
  }
  assert.equal(locked, true, "the stranger's own email+IP bucket does lock");
  const trusted = await newTotpFlow(db, s, u, { vid: newVid(), stage: "totp", trusted: true });
  const r = await verifyTotp(db, s as never, trusted.token, { code: await codeFor(u.secret, step) }, A, true, NOW);
  assert.equal(r.next, "ready", "the trusted browser completes its authenticator step");
});

test("same browser asking again keeps ITS code through the cooldown (resend), unchanged behaviour", async () => {
  const { u } = await fixture("resend");
  const vid = newVid(), A = ip(70, 1);
  const first = await requestCode(db, secrets, u.email, ctx(A), null, vid);
  const again = await requestCode(db, secrets, u.email, ctx(A), null, vid, true);
  assert.equal(again.sendCode, null, "inside the cooldown a resend is not emailed again");
  assert.equal(await verifies(first.flowToken, first.sendCode!.code, A), true);
});

test("migration 0027 not applied yet: login still works with the old per-user challenge (and logs it)", async () => {
  const migration = readFileSync(join(process.cwd(), "migrations", "0027_otp_challenge_slots.sql"), "utf8");
  await q(db, sql`DELETE FROM aa_login_challenges`);
  await q(db, sql`ALTER TABLE aa_login_challenges DROP COLUMN IF EXISTS slot`);
  await q(db, sql`ALTER TABLE aa_login_challenges ADD PRIMARY KEY (user_id)`);
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const { u } = await fixture("nomig");
    const A = ip(80, 1);
    const r = await requestCode(db, secrets, u.email, ctx(A), null, newVid());
    assert.ok(r.sendCode, "a code is issued");
    assert.equal(await verifies(r.flowToken, r.sendCode!.code, A), true, "and verifies");
    assert.ok(lines.some((l) => l.includes("migration_0027_not_applied")), "the missing migration is visible in the logs");
  } finally {
    console.error = orig;
    await q(db, sql.raw(migration));                                   // put the migration back for the other tests
  }
  const col = await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'aa_login_challenges' AND column_name = 'slot'`);
  assert.equal(col!.n, 1, "the migration is back in place for the other tests");
});
