import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, phoneLast8, NIGERIA_CALLING_CODE } from "./normalizePhone";

/* One person, one identity, however they write their number.
 *
 * The bug this file exists to prevent: two spellings of one customer producing
 * two identities. That is not cosmetic. It means a spam flag fails to match the
 * customer it was created for, an open-order count under-reports, and a
 * repeat-customer check misses someone buying for the second time.
 *
 * Every expected value below is written out by hand rather than recomputed with
 * the same library call, so this file cannot drift into asserting its own output
 * back at itself. */

/* ---- the core requirement: every spelling is one identity ---- */

test("every common Nigerian spelling of one number is the same identity", () => {
  const spellings = [
    "08012345678",
    "8012345678",
    "+2348012345678",
    "2348012345678",
    "+234 801 234 5678",
    "0801 234 5678",
    "0801-234-5678",
    "(0801) 234-5678",
    "002348012345678", // 00 international notation
    "  08012345678  ",
  ];
  const ids = new Set(spellings.map(normalizePhone));
  assert.equal(ids.size, 1, `expected 1 identity, got ${ids.size}: ${[...ids].join(", ")}`);
  assert.equal(normalizePhone("08012345678"), "+2348012345678");
});

test("the mobile prefixes the owner listed all resolve consistently", () => {
  // 070 / 080 / 081 / 090 / 091, each in local, trunk-dropped, bare-international
  // and spaced-international form, must resolve to the same number.
  for (const national of ["7012345678", "8012345678", "8123456780", "9023456789", "9123456780"]) {
    const expected = `${NIGERIA_CALLING_CODE}${national}`;
    const forms = [
      `0${national}`,              // local: 08012345678
      national,                    // trunk dropped: 8012345678
      expected,                    // international, with +
      expected.slice(1),           // international, without +
      // Spaced forms are grouping hints and must survive: a customer who types
      // "+234 801 234 5678" and one who types "+2348012345678" are one person.
      `+234 ${national}`,
      `+234 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`,
    ];
    for (const form of forms) {
      assert.equal(normalizePhone(form), expected, `${form} should be ${expected}`);
    }
  }
});

test("two genuinely different numbers never collapse into one identity", () => {
  // The opposite failure, and the more dangerous one: if distinct customers
  // merged, a restriction or a flag would silently apply to the wrong person.
  const distinct = ["+2348012345678", "+2348098765432", "+2348012345679", "+2347012345678"];
  assert.equal(new Set(distinct.map(normalizePhone)).size, distinct.length);
});

/* ---- international numbers must not be corrupted ---- */

test("a non-Nigerian number keeps its own identity", () => {
  // The exact regression in the hand-written parser this replaced: it prepended
  // 234 to everything, turning a US customer into a Nigerian one.
  assert.equal(normalizePhone("+12025550123"), "+12025550123");
  assert.equal(normalizePhone("+442079460958"), "+442079460958");
  assert.notEqual(normalizePhone("+12025550123"), normalizePhone("+2348012345678"));
});

test("a bare non-Nigerian number is not guessed at", () => {
  // With extract:true the library refuses to guess a country, so a bare
  // 11-digit US number resolves to nothing rather than to Nigeria.
  assert.equal(normalizePhone("12025550123"), null);
});

test("00 international notation resolves, rather than becoming a fake number", () => {
  // Left unhandled, "002348012345678" parses as +23402348012345678 - a valid
  // number belonging to nobody, which would split one customer into two.
  assert.equal(normalizePhone("002348012345678"), "+2348012345678");
  assert.equal(normalizePhone("0012025550123"), "+12025550123");
});

/* ---- malformed input yields no identity ---- */

test("a malformed Nigerian number yields no identity rather than a wrong one", () => {
  // Nine national digits is not a Nigerian mobile number. Accepting it would
  // invent an identity for a value that cannot exist.
  assert.equal(normalizePhone("234801234567"), null);
  assert.equal(normalizePhone("+234801234"), null);
  assert.equal(normalizePhone("+2348012345678901234"), null);
});

test("junk yields no identity, and never throws", () => {
  for (const bad of ["", "   ", "abc", "12345", "not a phone", "+++", "0", "00", "0001234"]) {
    assert.equal(normalizePhone(bad), null, `${JSON.stringify(bad)} should not resolve`);
  }
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
  assert.equal(normalizePhone(42 as unknown as string), null);
});

/* ---- null is an observation, never a verdict ---- */

test("null is returned so callers can skip identity checks, not reject", () => {
  // The contract that keeps the abuse layer conservative: no identity means no
  // identity-keyed restriction, never a customer-facing error.
  assert.equal(normalizePhone("garbage"), null);
});

/* ---- the secondary search key ---- */

test("last8 is a stable search aid derived from the canonical number", () => {
  // Verified against the real implementation: the last 8 DIGITS, so a Nigerian
  // number's national suffix without its leading zero.
  assert.equal(phoneLast8("+2348012345678"), "12345678");
  assert.equal(phoneLast8("+442079460958"), "79460958");
  assert.equal(phoneLast8(normalizePhone("0801 234 5678")), "12345678");
  // The same person, written two ways, gives the same search key.
  assert.equal(phoneLast8(normalizePhone("08012345678")), phoneLast8("+2348012345678"));
});

test("last8 is null when there is no canonical number to derive it from", () => {
  assert.equal(phoneLast8(null), null);
  assert.equal(phoneLast8("+234801"), null); // too short to have 8 digits
});

/* ---- stability ---- */

test("normalization is deterministic and idempotent", () => {
  // Re-normalizing a canonical value must return it unchanged, or a stored
  // identity would not compare equal to a freshly computed one.
  const once = normalizePhone("0801 234 5678")!;
  assert.equal(normalizePhone(once), once);
  assert.equal(normalizePhone(normalizePhone("0801-234-5678")), "+2348012345678");
});