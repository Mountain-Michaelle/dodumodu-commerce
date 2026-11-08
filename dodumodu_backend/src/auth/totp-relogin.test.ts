// Repeated login for a TRUE, fully configured user — TOTP and backup codes — on a
// bad network. These tests pin the guarantee "a real user is never answered with a
// false 401" while still rejecting real attacks:
//   TOTP  : new step ok; same step from the SAME browser/flow ok (retry, quick relogin);
//           same step from ANOTHER browser rejected; older step rejected; clock skew of
//           +-2 steps (+-60s) accepted, +-3 rejected; replay never burns an attempt.
//   Retry : repeating the request that already succeeded returns the same success
//           (lost response), also when two identical requests race.
//   Backup: single-use across logins, exact `remaining` 7..0, a wrong code consumes
//           nothing, case/dash insensitive, idempotent retry, two flows racing on one
//           code -> exactly one winner.
//   Speed : success paths stay within a fixed number of DB round trips.
// Live DB; fails fast (never skips) and refuses non-local databases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { q, q1, sql } from "./sql";
import { verifyTotp } from "./totp-verify";
import { finishStaffSession } from "./sessions";
import { lookupSession } from "./session-lookup";
import { AuthRejectError } from "./errors";
import { FLOW_TTL_SECS } from "./config";
import {
  openTestDb, closePools, testSecrets, makeTag, freshCtx, newVid, cleanupTag,
  createEnrolledUser, newTotpFlow, flowState, activeBlocks, codeFor, countingDb,
} from "./mfa-test-kit";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("relog");
after(async () => { await cleanupTag(db, tag); await closePools(); });

const NOW = 1_800_000_000_000;               // a fixed server clock for deterministic steps
const STEP = Math.floor(NOW / 30000);
const emailOf = (n: string) => `${tag}-${n}@example.com`;

test("TOTP re-login (same browser): same step, next step, repeated — never a false 401; older step refused", async () => {
  const u = await createEnrolledUser(db, s, emailOf("same"));
  const vid = newVid(), ip = freshCtx().ip;
  const login = async (step: number, nowMs: number) => {
    const f = await newTotpFlow(db, s, u, { vid, trusted: true });
    const r = await verifyTotp(db, s, f.token, { code: await codeFor(u.secret, step) }, ip, true, nowMs);
    assert.equal(r.next, "ready");
    assert.equal((await flowState(db, f.id)).totp_fails, 0);
    return f;
  };
  await login(STEP, NOW);                       // first login
  await login(STEP, NOW);                       // quick re-login inside the same 30s step
  await login(STEP, NOW + 5_000);               // and again (retry on a slow link)
  await login(STEP + 1, NOW + 30_000);          // next step
  await login(STEP + 1, NOW + 31_000);          // same step again
  await login(STEP + 2, NOW + 60_000);          // next step
  // A code OLDER than the newest consumed step is never accepted, even from the same browser.
  const f = await newTotpFlow(db, s, u, { vid, trusted: true });
  await assert.rejects(
    verifyTotp(db, s, f.token, { code: await codeFor(u.secret, STEP) }, ip, true, NOW + 60_000),
    AuthRejectError);
  assert.equal((await flowState(db, f.id)).totp_fails, 0, "a stale code is a replay, not a wrong guess");
});

test("TOTP replay from ANOTHER browser is rejected, burns no attempt, blocks nothing; a fresh code then works", async () => {
  const u = await createEnrolledUser(db, s, emailOf("other"));
  const ip = freshCtx().ip;
  const code = await codeFor(u.secret, STEP);
  const a = await newTotpFlow(db, s, u, { vid: newVid() });
  assert.equal((await verifyTotp(db, s, a.token, { code }, ip, true, NOW)).next, "ready");

  for (let i = 0; i < 6; i++) {                 // an attacker hammering the used code
    const b = await newTotpFlow(db, s, u, { vid: newVid() });
    await assert.rejects(verifyTotp(db, s, b.token, { code }, ip, true, NOW + i), AuthRejectError);
    const st = await flowState(db, b.id);
    assert.equal(st.totp_fails, 0);
    assert.equal(st.stage, "totp");
    assert.equal((await activeBlocks(db, b.id)).length, 0, "a replay is not a wrong guess: no device block");
  }
  // A cookie-less client (no vid) can never ride on someone else's consumed step either.
  const noVid = await newTotpFlow(db, s, u, { vid: null });
  await assert.rejects(verifyTotp(db, s, noVid.token, { code }, ip, true, NOW), AuthRejectError);
  // The legitimate next code works for that other browser.
  const c = await newTotpFlow(db, s, u, { vid: newVid() });
  const next = await verifyTotp(db, s, c.token, { code: await codeFor(u.secret, STEP + 1) }, ip, true, NOW + 30_000);
  assert.equal(next.next, "ready");
});

test("lost response: repeating the request that already succeeded returns the same success (TOTP)", async () => {
  const u = await createEnrolledUser(db, s, emailOf("retry"));
  const ip = freshCtx().ip;
  const f = await newTotpFlow(db, s, u, { vid: newVid() });
  const code = await codeFor(u.secret, STEP);
  const first = await verifyTotp(db, s, f.token, { code }, ip, true, NOW);
  assert.equal(first.next, "ready");
  // The client never saw the response and retries (several times) on the SAME flow:
  for (let i = 0; i < 3; i++) {
    const again = await verifyTotp(db, s, f.token, { code }, ip, true, NOW + 2_000 * (i + 1));
    assert.deepEqual(again, first, "identical success, not a 401");
  }
  assert.equal((await flowState(db, f.id)).stage, "ready", "retries do not move the flow");
  // ...but a DIFFERENT code on the ready flow is not "the same request": rejected.
  await assert.rejects(
    verifyTotp(db, s, f.token, { code: await codeFor(u.secret, STEP + 1) }, ip, true, NOW + 30_000),
    AuthRejectError);
  await assert.rejects(verifyTotp(db, s, f.token, { code: "000000" }, ip, true, NOW), AuthRejectError);
  // A stranger's flow does not inherit the retry privilege.
  const other = await newTotpFlow(db, s, u, { vid: newVid() });
  await assert.rejects(verifyTotp(db, s, other.token, { code }, ip, true, NOW), AuthRejectError);
});

test("double-submit race: two identical TOTP requests on one flow both succeed, the step is consumed once", async () => {
  const u = await createEnrolledUser(db, s, emailOf("race"));
  const ip = freshCtx().ip;
  const f = await newTotpFlow(db, s, u, { vid: newVid() });
  const code = await codeFor(u.secret, STEP);
  const [x, y] = await Promise.all([
    verifyTotp(db, s, f.token, { code }, ip, true, NOW),
    verifyTotp(db, s, f.token, { code }, ip, true, NOW),
  ]);
  assert.equal(x.next, "ready");
  assert.equal(y.next, "ready");
  const row = await q1<{ last: string; last_flow: string }>(db,
    sql`SELECT totp_last_step::text AS last, totp_last_flow::text AS last_flow FROM aa_users WHERE id = ${u.id}::uuid`);
  assert.equal(row?.last, String(STEP));
  assert.equal(row?.last_flow, f.id);
});

test("clock skew / slow typing: codes within +-2 steps (+-60s) are accepted, +-3 are not", async () => {
  const u = await createEnrolledUser(db, s, emailOf("skew"));
  const vid = newVid(), ip = freshCtx().ip;
  for (const d of [-2, -1, 0, 1, 2]) {            // ascending: each is newer than the last consumed
    const f = await newTotpFlow(db, s, u, { vid, trusted: true });
    const r = await verifyTotp(db, s, f.token, { code: await codeFor(u.secret, STEP + d) }, ip, true, NOW);
    assert.equal(r.next, "ready", `step offset ${d} must be accepted`);
  }
  for (const d of [-3, 3]) {
    const fresh = await createEnrolledUser(db, s, emailOf(`skew${d}`));
    const f = await newTotpFlow(db, s, fresh, { vid, trusted: true });
    await assert.rejects(
      verifyTotp(db, s, f.token, { code: await codeFor(fresh.secret, STEP + d) }, ip, true, NOW),
      AuthRejectError, `step offset ${d} must be rejected`);
  }
});

test("backup-code re-login: single-use across logins, exact remaining 7..0, wrong code consumes nothing", async () => {
  const u = await createEnrolledUser(db, s, emailOf("bk"));
  const vid = newVid(), ip = freshCtx().ip;
  const login = (code: string, allow = true) =>
    newTotpFlow(db, s, u, { vid, trusted: true }).then(async (f) => ({ f, run: () =>
      verifyTotp(db, s, f.token, { backupCode: code }, ip, allow) }));

  for (let i = 0; i < 8; i++) {
    const { run } = await login(u.backupCodes[i]);
    const r = await run();
    assert.equal(r.next, "ready");
    assert.equal(r.usedBackup, true);
    assert.equal(r.remaining, 7 - i, `after consuming code #${i + 1}`);
    // a wrong guess between logins consumes nothing and does not change `remaining`
    const w = await login("ZZZZZ-ZZZZZ");
    await assert.rejects(w.run(), AuthRejectError);
  }
  // every code is spent: re-using ANY of them is refused
  for (const c of [u.backupCodes[0], u.backupCodes[7]]) {
    const { run } = await login(c);
    await assert.rejects(run(), AuthRejectError);
  }
  const left = await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_backup_codes bc
    JOIN aa_backup_code_sets s ON s.id = bc.set_id WHERE s.user_id = ${u.id}::uuid AND bc.used_at IS NULL`);
  assert.equal(left?.n, 0);
});

test("backup code: case/dash/space-insensitive; lost-response retry on the same flow is the same success", async () => {
  const u = await createEnrolledUser(db, s, emailOf("bkretry"));
  const ip = freshCtx().ip;
  const f = await newTotpFlow(db, s, u, { vid: newVid() });
  const typed = u.backupCodes[0].toLowerCase().replace("-", " "); // as a person might type it
  const first = await verifyTotp(db, s, f.token, { backupCode: typed }, ip, true);
  assert.equal(first.next, "ready");
  assert.equal(first.remaining, 7);
  for (let i = 0; i < 3; i++) {
    const again = await verifyTotp(db, s, f.token, { backupCode: u.backupCodes[0] }, ip, true);
    assert.deepEqual(again, first, "retry returns the same success and the same remaining");
  }
  const spent = await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_backup_codes bc
    JOIN aa_backup_code_sets s ON s.id = bc.set_id WHERE s.user_id = ${u.id}::uuid AND bc.used_at IS NOT NULL`);
  assert.equal(spent?.n, 1, "retries never consume a second code");
  // another flow cannot reuse the spent code
  const g = await newTotpFlow(db, s, u, { vid: newVid() });
  await assert.rejects(verifyTotp(db, s, g.token, { backupCode: u.backupCodes[0] }, ip, true), AuthRejectError);
});

test("backup code races: duplicate on one flow both succeed; two flows on one code -> exactly one winner", async () => {
  const u = await createEnrolledUser(db, s, emailOf("bkrace"));
  const ip = freshCtx().ip;
  const f = await newTotpFlow(db, s, u, { vid: newVid() });
  const [a, b] = await Promise.all([
    verifyTotp(db, s, f.token, { backupCode: u.backupCodes[0] }, ip, true),
    verifyTotp(db, s, f.token, { backupCode: u.backupCodes[0] }, ip, true),
  ]);
  assert.equal(a.next, "ready");
  assert.equal(b.next, "ready");
  assert.equal(a.remaining, 7);
  assert.equal(b.remaining, 7);

  const g1 = await newTotpFlow(db, s, u, { vid: newVid() });
  const g2 = await newTotpFlow(db, s, u, { vid: newVid() });
  const res = await Promise.allSettled([
    verifyTotp(db, s, g1.token, { backupCode: u.backupCodes[1] }, ip, true),
    verifyTotp(db, s, g2.token, { backupCode: u.backupCodes[1] }, ip, true),
  ]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1, "single-use holds under a race");
  assert.equal(res.filter((r) => r.status === "rejected").length, 1);
});

test("full cycle: login -> session -> session EXPIRES -> login again, with TOTP and then with a backup code", async () => {
  const u = await createEnrolledUser(db, s, emailOf("cycle"), { role: "staff" });
  const vid = newVid(), ctx = freshCtx();
  const A = { ip: ctx.ip, ua: "itest", prefix: ctx.prefix, country: "NG", tier: "normal" as const };

  const sessionVia = async (factor: { code?: string; backupCode?: string }, nowMs: number) => {
    const f = await newTotpFlow(db, s, u, { vid, trusted: true });
    const r = await verifyTotp(db, s, f.token, factor, ctx.ip, true, nowMs);
    assert.equal(r.next, "ready");
    const fin = await finishStaffSession(db, { flowToken: f.token, ...A });
    assert.ok(await lookupSession(db, fin.sessionToken), "session resolves");
    return fin.sessionToken;
  };
  const expire = async (tok: string) => {
    await q(db, sql`UPDATE aa_sessions SET absolute_expires_at = now() - interval '1 minute'
      WHERE user_id = ${u.id}::uuid`);
    assert.equal(await lookupSession(db, tok), null, "an expired session cannot reach protected resources");
  };

  const t1 = await sessionVia({ code: await codeFor(u.secret, STEP) }, NOW);
  await expire(t1);
  // fresh login in the SAME 30s step right after expiry: must work (no stale-state 401)
  const t2 = await sessionVia({ code: await codeFor(u.secret, STEP) }, NOW + 3_000);
  await expire(t2);
  const t3 = await sessionVia({ code: await codeFor(u.secret, STEP + 1) }, NOW + 30_000);
  await expire(t3);
  const t4 = await sessionVia({ backupCode: u.backupCodes[0] }, NOW + 40_000);
  await expire(t4);
  const t5 = await sessionVia({ backupCode: u.backupCodes[1] }, NOW + 50_000);
  assert.ok(t5);
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id = ${u.id}::uuid`);
});

test("speed: success paths stay within a fixed DB round-trip budget (low-network guard)", async () => {
  const u = await createEnrolledUser(db, s, emailOf("speed"));
  const ip = freshCtx().ip;
  const meter = countingDb(db);

  const f = await newTotpFlow(db, s, u, { vid: newVid() });
  meter.reset();
  const r = await verifyTotp(meter.db, s, f.token, { code: await codeFor(u.secret, STEP) }, ip, true, NOW);
  assert.equal(r.next, "ready");
  // loadFlow + (user row || reserve) + ONE combined consume-and-advance + clearKeys
  assert.ok(meter.count() <= 5, `TOTP success used ${meter.count()} round trips (budget 5)`);

  meter.reset();
  const again = await verifyTotp(meter.db, s, f.token, { code: await codeFor(u.secret, STEP) }, ip, true, NOW);
  assert.equal(again.next, "ready");
  assert.ok(meter.count() <= 3, `idempotent retry used ${meter.count()} round trips (budget 3)`);

  const g = await newTotpFlow(db, s, u, { vid: newVid() });
  meter.reset();
  const b = await verifyTotp(meter.db, s, g.token, { backupCode: u.backupCodes[0] }, ip, true);
  assert.equal(b.usedBackup, true);
  assert.ok(meter.count() <= 4, `backup success used ${meter.count()} round trips (budget 4)`);
});

test("low-network config guards: a login flow outlives a slow user and the TOTP window tolerates skew", async () => {
  assert.ok(FLOW_TTL_SECS >= 600, `flow TTL ${FLOW_TTL_SECS}s is too short for slow networks (need >= 600)`);
  const u = await createEnrolledUser(db, s, emailOf("ttl"));
  const f = await newTotpFlow(db, s, u, { vid: newVid() });
  const row = await q1<{ secs: number }>(db,
    sql`SELECT extract(epoch FROM (expires_at - now()))::int AS secs FROM aa_auth_flows WHERE id = ${f.id}::uuid`);
  assert.ok(row && row.secs > 600);
});
