import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReason, MIN_REASON_LENGTH } from "./spamService";

/* A permanent exclusion is the one irreversible thing in this system.
 *
 * So the guard is on the REASON, and these tests are about the ways a reason check
 * could be too easy to pass. A flag with no explanation cannot be reviewed later,
 * cannot be audited honestly, and trains an operator to click without thinking -
 * which is how a real customer ends up permanently blocked over a
 * misunderstanding. */

// A stub DB that must never be reached: these tests are about argument validation,
// which happens before any query.
const unreachableDb = new Proxy({}, { get() { throw new Error("no query should be reached"); } }) as never;

test("a meaningful reason is accepted and normalized", () => {
  const reason = validateReason("  Repeated fake orders using different phone numbers  ");
  assert.equal(reason, "Repeated fake orders using different phone numbers");
});

test("an empty reason is refused", () => {
  assert.throws(() => validateReason(""), /reason is required/i);
  assert.throws(() => validateReason("   "), /reason is required/i);
  assert.throws(() => validateReason(null), /reason is required/i);
  assert.throws(() => validateReason(undefined), /reason is required/i);
});

test("a reason that records nothing is refused", () => {
  // The point of the whole rule. "Spam" is what the button is already called, so
  // accepting it would store no information at all.
  for (const lazy of ["spam", "SPAM", " spam ", "Spammer", "fraud", "fake", "scam", "test"]) {
    assert.throws(() => validateReason(lazy), /does not explain anything/i, `"${lazy}" must be refused`);
  }
});

test("a too-short reason is refused, with the bar stated", () => {
  assert.throws(() => validateReason("no"), new RegExp(`${MIN_REASON_LENGTH} characters`));
  assert.throws(() => validateReason("looks sus"), new RegExp(`${MIN_REASON_LENGTH} characters`));
});

test("a long enough but contentless reason is still accepted", () => {
  // Deliberately NOT filtered by keyword. The service cannot judge whether an
  // operator's judgement is correct - only whether they recorded one. Over-eager
  // filtering would reject honest phrasings ("customer confirmed this was not
  // their order") and push operators toward the terse habits the check exists to
  // prevent.
  assert.equal(
    validateReason("Customer called to say this was not their order"),
    "Customer called to say this was not their order",
  );
});

test("internal whitespace is collapsed so a reason reads as one sentence", () => {
  assert.equal(
    validateReason("Repeated   fake orders\nusing different phones"),
    "Repeated fake orders using different phones",
  );
});

test("the acceptable examples from the brief all pass", () => {
  for (const example of [
    "Repeated fake orders using different phone numbers",
    "Multiple failed orders and rapid identity changes",
    "Customer confirmed this was not their order",
  ]) {
    assert.equal(validateReason(example), example);
  }
});

void unreachableDb;