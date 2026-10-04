import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, recordOutcome, configFor } from "./guardService";
import { normalizePhone } from "../shared/normalizePhone";
import type { Env } from "../env";

/* The guard must never be the reason a customer cannot buy.
 *
 * These tests use a stub repository rather than a database, because the property
 * under test is not SQL correctness - it is that the guard is incapable of
 * rejecting an order and incapable of throwing into the order path. Both are
 * proved by the absence of any response-writing code in guardService at all. */

/** A Db stand-in whose methods are supplied per test. */
const stubDb = (impl: Record<string, unknown>) => impl as never;

/**
 * A Db stand-in that records the SQL it is asked to run.
 *
 * Added after a real bug: the outcome counters were written with a computed key in
 * drizzle's `.values()`/`.set()`, which are silently dropped when unrecognised, so
 * the statement that reached Postgres named no counter at all. Every test here
 * mocked the query-builder shape and passed, because a builder mock cannot tell a
 * dropped key from a correct one. Capturing the rendered statement can.
 */
function sqlSpy(): any {
  const spy = {
    sql: "",
    execute(query: unknown) {
      spy.sql = flattenSql(query).replace(/\s+/g, " ");
      return Promise.resolve({ rows: [{}] });
    },
  };
  return spy;
}

/** Flattens a drizzle SQL object to its literal text, ignoring bound parameters. */
function flattenSql(node: any): string {
  const out: string[] = [];
  const visit = (n: any) => {
    if (n == null) return;
    if (typeof n === "string") { out.push(n); return; }
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (Array.isArray(n.value)) { visit(n.value); return; }
    if (typeof n.value === "string") { out.push(n.value); return; }
    if (Array.isArray(n.queryChunks)) { visit(n.queryChunks); return; }
  };
  visit(node);
  return out.join("");
}

const envWith = (vars: Record<string, string> = {}): Env =>
  ({ RL_MODE: "shadow", ...vars } as unknown as Env);

// Silence the shadow warning while still exercising the real code path.
/* ---- it cannot reject ---- */

test("shadow mode reports what it WOULD do and never acts", async () => {
  // The verdict is DATA. There is no response object anywhere in guardService, so
  // this cannot become a 429 by accident.
  const calls: string[] = [];
  const db = stubDb({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  });
  const verdict = await evaluate(db, envWith(), { ip: "1.2.3.4", rawPhone: "08012345678", replay: false });
  assert.equal(verdict.wouldRestrict, false);
  assert.equal(verdict.ip, "1.2.3.4");
  void calls;
});

/* ---- idempotent replays are invisible ---- */

test("a replay is not counted and not evaluated", async () => {
  // The caller passes replay=true because it already did the idempotency lookup.
  // Crucially, NO repository method may be reached at all.
  let touchedDb = false;
  const db = stubDb(new Proxy({}, {
    get() { touchedDb = true; throw new Error("replay must not touch the database"); },
  }));
  const verdict = await evaluate(db, envWith(), { ip: "1.2.3.4", rawPhone: "08012345678", replay: true });
  assert.equal(verdict.wouldRestrict, false);
  assert.equal(verdict.reason, "idempotent_replay");
  assert.equal(touchedDb, false, "a replay must not increment a counter");
});

/* ---- fail open ---- */

test("a database failure allows the order and logs a labelled error", async () => {
  // The whole point: abuse protection must never take the storefront down.
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  try {
    const db = stubDb({
      select: () => { throw new Error("Neon connection terminated"); },
    });
    const verdict = await evaluate(db, envWith(), { ip: "1.2.3.4", rawPhone: "08012345678", replay: false });
    assert.equal(verdict.wouldRestrict, false, "must fail open");
    assert.equal(verdict.reason, "abuse_system_error_fail_open");
    assert.ok(errors.some((line) => line.includes("abuse_system_error")), "the failure must be labelled");
  } finally {
    console.error = original;
  }
});

test("a failure while RECORDING also fails open, after the decision was made", async () => {
  // Reading succeeded but writing failed. The order must still go through.
  const original = console.error;
  console.error = () => {};
  try {
    const db = stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{
              ip: "1.2.3.4", windowStart: 0, posts: 0, distinctPhones: 0,
              validationFailures: 0, turnstileFailures: 0, successfulProgressions: 0,
            }],
          }),
        }),
      }),
      insert: () => { throw new Error("write failed"); },
    });
    const verdict = await evaluate(db, envWith(), { ip: "1.2.3.4", rawPhone: "08012345678", replay: false });
    assert.equal(verdict.wouldRestrict, false);
  } finally {
    console.error = original;
  }
});

/* ---- unknown phone is not suspicion ---- */

test("an unresolvable phone yields phoneKnown=false rather than an invented identity", async () => {
  const db = stubDb({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  });
  const verdict = await evaluate(db, envWith(), { ip: "1.2.3.4", rawPhone: "not a phone", replay: false });
  assert.equal(verdict.phoneKnown, false);
  assert.equal(verdict.phoneNorm, null);
  assert.equal(verdict.wouldRestrict, false, "uncertain recognition must never refuse a customer");
});

test("a resolvable phone yields the shared canonical identity", async () => {
  const db = stubDb({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  });
  const verdict = await evaluate(db, envWith(), { ip: "1.2.3.4", rawPhone: "0801 234 5678", replay: false });
  assert.equal(verdict.phoneKnown, true);
  // The SAME normalizer the rest of the application uses, not a second copy.
  assert.equal(verdict.phoneNorm, normalizePhone("08012345678"));
});

/* ---- mode behaviour ---- */

test("mode=off touches nothing and allows everything", async () => {
  let touched = false;
  const db = stubDb(new Proxy({}, { get() { touched = true; return () => {}; } }));
  const verdict = await evaluate(db, envWith({ RL_MODE: "off" }), { ip: "1.2.3.4", rawPhone: "08012345678", replay: false });
  assert.equal(verdict.wouldRestrict, false);
  assert.equal(verdict.reason, "mode_off");
  assert.equal(touched, false);
});

test("shadow and enforce agree on the VERDICT, differing only in action", async () => {
  // Proved here as well as in counters.test: if these disagreed, the shadow log
  // would be measuring something that never happens.
  const db = stubDb({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  });
  const shadow = await evaluate(db, envWith({ RL_MODE: "shadow" }), { ip: "1.2.3.4", rawPhone: "08012345678", replay: false });
  const enforce = await evaluate(db, envWith({ RL_MODE: "enforce" }), { ip: "1.2.3.4", rawPhone: "08012345678", replay: false });
  assert.equal(shadow.wouldRestrict, enforce.wouldRestrict);
});

test("an allowlisted IP is allowed without touching counters", async () => {
  const db = stubDb({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  });
  const verdict = await evaluate(db, envWith({ RL_IP_ALLOWLIST: "1.2.3.4" }), {
    ip: "1.2.3.4", rawPhone: "08012345678", replay: false,
  });
  assert.equal(verdict.wouldRestrict, false);
  assert.match(String(verdict.reason), /allowlisted/);
});

/* ---- outcome evidence ---- */

test("a created order in a progression status records success", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    // Observes the RENDERED statement rather than the shape of a query builder.
    // The previous version mocked .values()/.onConflictDoUpdate() and passed
    // happily while the real statement named no counter at all - see the note in
    // activityRepo.ts. Reading the SQL is both simpler and harder to fool.
    const db = sqlSpy();
    await recordOutcome(db, envWith(), { ip: "1.2.3.4", outcome: "created", orderStatus: "confirmed_cod" });
    assert.match(db.sql, /successful_progressions/);
    assert.match(db.sql, /abuse_ip_windows\.successful_progressions\s*\+\s*1/);
  } finally {
    console.error = original;
  }
});

test("awaiting_payment and failed are NOT recorded as successful progression", async () => {
  // A failed payment is a normal thing that happens to honest people on bad
  // networks. Treating it as success would disarm the interlock; treating it as
  // fraud would penalise them. It is simply neither.
  for (const status of ["awaiting_payment", "failed"]) {
    const original = console.error;
    console.error = () => {};
    try {
      const db = sqlSpy();
      await recordOutcome(db, envWith(), { ip: "1.2.3.4", outcome: "created", orderStatus: status });
      assert.equal(db.sql, "", `${status} must write no counter at all`);
    } finally {
      console.error = original;
    }
  }
});

test("a validation failure records the validation counter, not success", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const db = sqlSpy();
    await recordOutcome(db, envWith(), { ip: "1.2.3.4", outcome: "validation_failed" });
    assert.match(db.sql, /validation_failures/);
    assert.match(db.sql, /abuse_ip_windows\.validation_failures\s*\+\s*1/);
    // The important half: a failed request must NOT disarm the success interlock.
    assert.doesNotMatch(db.sql, /set successful_progressions/, "the interlock must not be disarmed by a failed request");
  } finally {
    console.error = original;
  }
});

test("an outcome-recording failure never throws into the order path", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const db = stubDb({ insert: () => { throw new Error("db gone"); } });
    // Must resolve, not reject: the order was already created by this point.
    await recordOutcome(db, envWith(), { ip: "1.2.3.4", outcome: "created", orderStatus: "paid" });
  } finally {
    console.error = original;
  }
});

/* ---- config wiring ---- */

test("config defaults to shadow, so enforcement cannot be enabled by accident", () => {
  assert.equal(configFor({} as Env).mode, "shadow");
});
