import { test } from "node:test";
import assert from "node:assert/strict";
import {
  restrictionDecision, windowStartFor, isCurrentWindow, isLegitimateProgression,
  type EstablishedEvidence,
} from "./counters";
import { abuseConfigFrom, type AbuseConfig } from "./config";
import * as activityRepo from "./activityRepo";

/* The rules that can cost a customer an order.
 *
 * Every test here is about a way this could be WRONG for a real person, not about
 * whether the arithmetic works. A flood that gets through is a cost; a genuine
 * customer who is wrongly refused is a lost sale, and the mistake stays invisible
 * until somebody complains that the site "broke". */

const NOW = 1_800_000_000;
const WINDOW = 900;

const config = (over: Partial<AbuseConfig> = {}): AbuseConfig =>
  ({ ...abuseConfigFrom({ RL_MODE: "shadow" }), ...over });

const evidence = (over: Partial<EstablishedEvidence> = {}): EstablishedEvidence => ({
  windowStart: windowStartFor(NOW, WINDOW),
  posts: 0,
  distinctPhones: 0,
  validationFailures: 0,
  turnstileFailures: 0,
  successfulProgressions: 0,
  ...over,
});

/** Thresholds small enough that a test can actually reach them. */
const strict = config({ ipPosts: 5, distinctPhones: 3, failures: 4, successFloor: 1 });

const decide = (e: EstablishedEvidence, c = strict, ip = "203.0.113.5") =>
  restrictionDecision(e, c, { nowSeconds: NOW, ip });

/* ---- the central invariant ---- */

test("the request that CROSSES a threshold is not the one that gets refused", () => {
  // THE rule. This is why restrictionDecision is given the PRE-write evidence: the
  // fifth request reads 4 established posts, which is below the threshold of 5, so
  // it is allowed. Only the sixth reads 5 and can be refused.
  const beforeFifth = evidence({ posts: 4, distinctPhones: 3, validationFailures: 4 });
  assert.equal(decide(beforeFifth).restrict, false, "the crossing request must be allowed");

  const beforeSixth = evidence({ posts: 5, distinctPhones: 3, validationFailures: 4 });
  assert.equal(decide(beforeSixth).restrict, true, "a later request may be restricted");
});

test("a single signal, or two together, is never enough", () => {
  // The conjunction is the whole safety property. Each of these is a plausible
  // reason to restrict in isolation, and each would block real customers.
  //
  // Note what is deliberately ABSENT: "many posts + many phones + many failures"
  // with ZERO successes. That satisfies all four signals and DOES restrict - the
  // intended behaviour, not an oversight. What must never restrict is any
  // combination missing at least one leg of the conjunction.
  const alone: [string, EstablishedEvidence][] = [
    ["posts alone (one person retrying)", evidence({ posts: 500, distinctPhones: 1 })],
    ["posts + many phones, no failures", evidence({ posts: 500, distinctPhones: 200 })],
    ["posts + failures, one phone", evidence({ posts: 500, distinctPhones: 1, validationFailures: 500 })],
    ["phones + failures, few posts", evidence({ posts: 2, distinctPhones: 200, validationFailures: 500 })],
    ["all three, but real success",
      evidence({ posts: 500, distinctPhones: 200, validationFailures: 500, successfulProgressions: 1 })],
  ];
  for (const [label, e] of alone) {
    assert.equal(decide(e).restrict, false, `${label} must NOT restrict`);
  }
});

test("only the full conjunction restricts", () => {
  const all = evidence({
    posts: 5, distinctPhones: 3, validationFailures: 2, turnstileFailures: 2,
  });
  const verdict = decide(all);
  assert.equal(verdict.restrict, true);
  assert.equal(verdict.reason.code, "correlated_activity");
});

/* ---- the shared-carrier-NAT interlock ---- */

test("successful orders DISARM the block entirely", () => {
  // The single most important test for a Nigerian storefront. A carrier NAT
  // concentrates many real customers behind one address, so its failure counts are
  // genuinely high - and it is still a legitimate address. ONE real order through
  // the IP is enough to prevent the restriction, however extreme everything else.
  const sharedButReal = evidence({
    posts: 5000, distinctPhones: 500, validationFailures: 900, turnstileFailures: 900,
    successfulProgressions: 1,
  });
  const verdict = decide(sharedButReal);
  assert.equal(verdict.restrict, false, "a single success must disarm the block");
  assert.match(verdict.reason.detail, /disarm the block/);
});

test("success is negative evidence, not a permanent bypass", () => {
  // The inverse error, which would make the layer useless: a customer who bought
  // once must not be exempt forever. Success only disarms the WINDOW it happened
  // in; once that window expires it is gone.
  const current = evidence({ successfulProgressions: 1 });
  assert.equal(decide(current).restrict, false, "success in the current window disarms it");

  const stale = {
    ...evidence({ successfulProgressions: 1 }),
    windowStart: windowStartFor(NOW - WINDOW, WINDOW),
  };
  assert.equal(decide(stale).restrict, false, "a stale window never justifies a block");
});

test("an expired window is never counted as continuing evidence", () => {
  // Otherwise an old busy hour could keep refusing requests hours later.
  const old = {
    ...evidence({ posts: 5000, distinctPhones: 500, validationFailures: 900 }),
    windowStart: windowStartFor(NOW - 5000, WINDOW),
  };
  assert.equal(decide(old).restrict, false);
});

/* ---- uncertainty never manufactures suspicion ---- */

test("an allowlisted IP is never restricted, however extreme the evidence", () => {
  const c = config({ ...strict, ipAllowlist: ["203.0.113.5"] });
  const extreme = evidence({
    posts: 99999, distinctPhones: 9999, validationFailures: 9999, turnstileFailures: 9999,
  });
  assert.equal(decide(extreme, c).restrict, false);
  assert.equal(decide(extreme, c).reason.code, "allowlisted");
});

test("mode=off never restricts, even in shadow-eligible conditions", () => {
  const c = config({ ...strict, mode: "off" });
  const abusive = evidence({ posts: 500, distinctPhones: 200, validationFailures: 500 });
  assert.equal(decide(abusive, c).restrict, false);
  assert.equal(decide(abusive, c).reason.code, "mode_off");
});

test("shadow computes the same verdict as enforce, so it measures what would happen", () => {
  // If shadow returned a different answer than enforce, the shadow report would be
  // measuring something that never happens. Shadow differs ONLY in not acting.
  const abusive = evidence({ posts: 500, distinctPhones: 200, validationFailures: 500 });
  const shadow = decide(abusive, config({ ...strict, mode: "shadow" }));
  const enforce = decide(abusive, config({ ...strict, mode: "enforce" }));
  assert.equal(shadow.restrict, enforce.restrict);
});

/* ---- boundaries ---- */

test("thresholds are inclusive: reaching the configured number is enough", () => {
  const at = evidence({ posts: 5, distinctPhones: 3, validationFailures: 4 });
  assert.equal(decide(at).restrict, true);
  const below = evidence({ posts: 4, distinctPhones: 3, validationFailures: 4 });
  assert.equal(decide(below).restrict, false);
});

test("the missing-signal report names what was below, for threshold tuning", () => {
  // This detail is the raw material for choosing real thresholds from shadow data:
  // it says how close genuine traffic came to each bar. So it must name ONLY the
  // signals genuinely below threshold - here posts is high and phones is high,
  // and failures is the one short.
  const verdict = decide(evidence({ posts: 12, distinctPhones: 4, validationFailures: 1 }));
  assert.equal(verdict.restrict, false);
  assert.match(verdict.reason.detail, /failures 1\/4/);
  // Signals that were met must NOT be listed as missing.
  assert.ok(!/posts 12\/5/.test(verdict.reason.detail), "a met signal must not be reported missing");
  assert.ok(!/distinct phones 4\/3/.test(verdict.reason.detail), "a met signal must not be reported missing");
});

test("a zero-config deployment is inert and conservative", () => {
  // No env set at all: shadow mode, and thresholds far above anything real.
  const c = abuseConfigFrom({});
  assert.equal(c.mode, "shadow");
  assert.equal(c.ipPosts, 120);
  assert.equal(c.successFloor, 3);
  assert.deepEqual(c.ipAllowlist, []);
});

/* ---- window maths ---- */

test("window buckets are stable and aligned", () => {
  assert.equal(windowStartFor(NOW, WINDOW), Math.floor(NOW / WINDOW) * WINDOW);
  // Anything inside the same window shares a bucket.
  assert.equal(windowStartFor(NOW, WINDOW), windowStartFor(NOW + WINDOW - 1, WINDOW));
  assert.equal(isCurrentWindow(evidence(), NOW, WINDOW), true);
  assert.equal(isCurrentWindow(evidence(), NOW + WINDOW, WINDOW), false);
});

/* ---- status evidence ---- */

test("legitimate progression statuses are recognised", () => {
  for (const status of ["paid", "confirmed_cod", "delivered"]) {
    assert.equal(isLegitimateProgression(status), true, `${status} is progression`);
  }
});

test("confirmed_cod counts as progression, NOT as suspicious", () => {
  // Under a cash-on-delivery model this is the ordinary state of every good order
  // in transit. Treating it as evidence of fraud would penalise how the business
  // is paid.
  assert.equal(isLegitimateProgression("confirmed_cod"), true);
});

test("awaiting_payment and failed are NOT automatically treated as spam", () => {
  // A prepaid order awaiting payment is a normal order. A failed payment is a
  // normal thing that happens to honest people on bad networks. Neither is
  // evidence of fraud on its own.
  assert.equal(isLegitimateProgression("awaiting_payment"), false);
  assert.equal(isLegitimateProgression("failed"), false);
});

test("an unknown or absent status is not progression, and not a verdict", () => {
  assert.equal(isLegitimateProgression(null), false);
  assert.equal(isLegitimateProgression(undefined), false);
  assert.equal(isLegitimateProgression("spam"), false);
});

/* A regression test for a bug none of the tests above could see.
 *
 * bump() built its statement with a computed column key. drizzle silently DROPS keys
 * it does not recognise from .values() and .set(), so what actually reached Postgres
 * was `values (..., default, default, default)` with no SET clause for the counter -
 * and validation_failures, turnstile_failures and successful_progressions stayed
 * permanently zero against a real database. Every other test here passed, because a
 * stub database never renders SQL.
 *
 * successful_progressions is the serious one: it is the interlock that stops a
 * Nigerian carrier NAT being treated as abusive. It read zero for every address,
 * always, which means the disarming signal this whole design rests on was absent.
 *
 * So this test asserts on the RENDERED STATEMENT. It needs no database and is the
 * cheapest possible guard against the class of bug where correct-looking code
 * produces a silent no-op. */
test("bump() renders a statement that really names and increments each counter", async () => {
  // Paired deliberately: each recorder with the column it is supposed to touch, so
  // the assertion cannot pass by finding some other counter's statement.
  const cases: Array<[string, (db: any, ip: string, w: number) => Promise<unknown>]> = [
    ["validation_failures", activityRepo.recordValidationFailure],
    ["turnstile_failures", activityRepo.recordTurnstileFailure],
    ["successful_progressions", activityRepo.recordSuccessfulProgression],
  ];

  for (const [name, record] of cases) {
    const rendered: string[] = [];
    const db = {
      execute(query: any) {
        rendered.push(flatten(query));
        return Promise.resolve({ rows: [{ posts: 0 }] });
      },
    } as any;

    await record(db, "1.2.3.4", 1);

    assert.equal(rendered.length, 1, `${name}: expected exactly one statement`);
    const statement = rendered[0];
    // Named in the INSERT column list...
    assert.ok(
      statement.includes(`(ip,window_start,${name}`),
      `${name} must be inserted - got: ${statement}`,
    );
    // ...and incremented on conflict. Inserting without incrementing was the bug:
    // the row appeared once and then sat at 1 for the whole window.
    assert.ok(
      statement.includes(`abuse_ip_windows.${name}+1`),
      `${name} must be incremented on conflict, not only inserted - got: ${statement}`,
    );
  }
});

/**
 * Flattens a drizzle SQL object into its literal text.
 *
 * Two chunk shapes matter: a plain string, and `{ value }`, which is what sql.raw()
 * produces. Parameterised values are deliberately skipped - they carry the
 * customer's data, and interpolating them into an assertion would be noise.
 */
function flatten(node: any): string {
  const out: string[] = [];
  const visit = (n: any) => {
    if (n == null) return;
    if (typeof n === "string") { out.push(n); return; }
    if (Array.isArray(n)) { n.forEach(visit); return; }
    // sql.raw() wraps a plain array of text, e.g. ["validation_failures"].
    if (Array.isArray(n.value)) { visit(n.value); return; }
    if (typeof n.value === "string") { out.push(n.value); return; }
    if (Array.isArray(n.queryChunks)) { visit(n.queryChunks); return; }
  };
  visit(node);
  // Whitespace is normalised so the assertions below can be written as readable
  // fragments rather than depending on how the template literal was indented.
  // All whitespace is removed, not merely collapsed: the template literal wraps
  // mid-identifier, so a line break can land inside a column name.
  return out.join("").replace(/\s+/g, "");
}
