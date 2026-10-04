import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  normalizePhone, normalizeEmail, sha256, hashPhone, hashEmail,
} from "./hashing";

/* Turning one person into one stable digest.
 *
 * The bug these pin: hashing whatever string arrived. "08031234567" and
 * "+234 803 123 4567" are the same Nigerian phone number, and an ad platform
 * matching on a hash sees only the digest. Hash the raw strings and the same
 * customer produces two digests, neither matches the other, and match rate —
 * the metric that decides whether the algorithm finds more buyers like them —
 * collapses silently. No error is raised anywhere; the ads just get worse.
 *
 * Every expected digest below is recomputed in the test from an independently
 * written canonical string, so this file cannot drift into asserting its own
 * output back at itself. */

const independent = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

test("every spelling of one phone number converges on one digest", () => {
  // The whole point. If these ever differ, the same customer is counted as two.
  const spellings = [
    "08031234567",
    "+2348031234567",
    "2348031234567",
    "0803 123 4567",
    "+234 803 123 4567",
    "0803-123-4567",
    "(0803) 123 4567",
    "  08031234567  ",
  ];
  const digests = new Set(spellings.map((s) => hashPhone(s)));
  assert.equal(digests.size, 1, `expected 1 digest, got ${digests.size}: ${[...digests].join(", ")}`);
  assert.equal(hashPhone("08031234567"), independent("2348031234567"));
});

test("the national trunk zero becomes the country code", () => {
  // Canonical form is now E.164 WITH the leading "+", shared with the abuse layer
  // so both agree on who the customer is. The DIGEST is unaffected - see the
  // digest-stability test below, which is the part that would actually hurt.
  assert.equal(normalizePhone("08031234567"), "+2348031234567");
  assert.equal(normalizePhone("+2348031234567"), "+2348031234567");
  assert.equal(normalizePhone("2348031234567"), "+2348031234567");
});

test("a number typed without its trunk zero is still Nigerian", () => {
  // "803 123 4567" is how a great many Nigerians write it. Refusing it would
  // throw away real customers, not bad data.
  assert.equal(normalizePhone("8031234567"), "+2348031234567");
  assert.equal(normalizePhone("+234 803 123 4567"), "+2348031234567");
});

test("the digest is unchanged by the move to shared E.164 normalization", () => {
  // THE REGRESSION THIS GUARDS. The shared normalizer returns "+2348031234567"
  // where the old hand-written one returned "2348031234567". Hashing that string
  // verbatim would give every existing customer a NEW digest, and the ad
  // platforms - which match on the hash - would see one person as two. The
  // digest input therefore strips the "+" while the STORED identity keeps it.
  assert.equal(hashPhone("08031234567"), independent("2348031234567"));
  assert.equal(hashPhone("+2348031234567"), independent("2348031234567"));
  assert.equal(hashPhone("2348031234567"), independent("2348031234567"));
});

test("a non-Nigerian number now hashes to its own country code, not 234", () => {
  // The old parser prepended 234 to everything, so a US customer hashed to a
  // Nigerian identity. That is a real match-quality bug, not a cosmetic one.
  assert.equal(hashPhone("+12025550123"), independent("12025550123"));
  assert.notEqual(hashPhone("+12025550123"), independent("23412025550123"));
});

test("a different number is a different digest", () => {
  assert.notEqual(hashPhone("08031234567"), hashPhone("08039876543"));
});

test("an unusable phone is null rather than a digest that can never match", () => {
  // A wrong digest is worse than none: it still counts as a failed match
  // attempt against the platform's match-quality score.
  for (const bad of ["", "   ", "abc", "12", "0803", null, undefined]) {
    assert.equal(normalizePhone(bad), null, `${JSON.stringify(bad)} should not normalize`);
    assert.equal(hashPhone(bad), null);
  }
});

test("an implausibly long number is refused instead of truncated", () => {
  assert.equal(normalizePhone("234803123456789012"), null);
});

/* ---- email ---- */

test("email is trimmed and lowercased, then hashed", () => {
  assert.equal(normalizeEmail("  Buyer@Example.COM "), "buyer@example.com");
  assert.equal(hashEmail("  Buyer@Example.COM "), independent("buyer@example.com"));
  assert.equal(hashEmail("buyer@example.com"), hashEmail("BUYER@EXAMPLE.COM"));
});

test("a value that cannot be an address yields no digest", () => {
  for (const bad of ["", "nope", "@example.com", "buyer@", "buyer@example", "a@b@c.com", "a b@c.com"]) {
    assert.equal(normalizeEmail(bad), null, `${JSON.stringify(bad)} should not normalize`);
    assert.equal(hashEmail(bad), null);
  }
});

test("a digest is 64 lowercase hex characters", () => {
  // Shape, not content: what the platforms parse out of the payload.
  assert.match(hashPhone("08031234567")!, /^[0-9a-f]{64}$/);
  assert.match(hashEmail("buyer@example.com")!, /^[0-9a-f]{64}$/);
});

test("hashing is unsalted and therefore stable across processes", () => {
  // Both platforms require that the same input hash identically on their side,
  // so there is no per-deployment salt anywhere in this path.
  assert.equal(sha256("2348031234567"), independent("2348031234567"));
});