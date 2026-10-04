import { test } from "node:test";
import assert from "node:assert/strict";
import { codPolicyService, decideCod, CodNotAvailableError } from "./codPolicyService";
import { normalizeState, isStateInList } from "./nigeriaStates";
import { CLOSED_PAYMENT_RULES } from "../data/paymentRulesRepo";

// The seeded rule from migrations/0002_payment_rules.sql: COD in the four
// launch states, and 5+ items always pay up front.
const RULES = { codStates: ["Lagos", "Ogun", "Enugu", "Abuja"], codBulkThreshold: 5 };

test("COD is allowed in an eligible state below the bulk threshold", () => {
  assert.deepEqual(decideCod("Lagos", 1, RULES), { allowed: true, reason: null, message: null });
  assert.equal(decideCod("Enugu", 4, RULES).allowed, true, "4 is the largest eligible quantity");
});

test("COD is refused outside the eligible states, with the state in the message", () => {
  const decision = decideCod("Kano", 1, RULES);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "state");
  assert.ok(decision.message?.includes("Kano"), "names the state the customer picked");
  assert.ok(!decision.message?.includes("bulk"), "does not blame quantity they could fix");
});

test("5 or more items always pay up front, with the boundary named in the message", () => {
  const decision = decideCod("Lagos", 5, RULES);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "bulk");
  assert.ok(decision.message?.includes("up to 4 items"), `names the ceiling: ${decision.message}`);
  assert.equal(decideCod("Lagos", 20, RULES).reason, "bulk");
});

test("a bad state outranks a bulk quantity, because it is the unfixable reason", () => {
  const decision = decideCod("Kano", 40, RULES);
  assert.equal(decision.reason, "state");
});

test("eligibility survives case, whitespace and the Abuja/FCT split", () => {
  for (const spelling of ["lagos", "  Lagos  ", "Lagos State", "LAGOS state"]) {
    assert.equal(decideCod(spelling, 2, RULES).allowed, true, spelling);
  }
  // The dropdown says "Abuja", a waybill says "FCT" — same place, one rule.
  assert.equal(normalizeState("Abuja"), normalizeState("FCT"));
  assert.equal(decideCod("FCT", 2, RULES).allowed, true);
  assert.equal(decideCod("f.c.t.", 2, RULES).allowed, true);
  // And it works whichever spelling the admin stored.
  assert.equal(decideCod("Abuja", 2, { codStates: ["FCT"], codBulkThreshold: 5 }).allowed, true);
});

test("nothing is eligible when the state list is empty (COD turned off on purpose)", () => {
  const decision = decideCod("Lagos", 1, { codStates: [], codBulkThreshold: 99 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "state");
});

test("the fail-closed default denies every COD order", () => {
  assert.equal(CLOSED_PAYMENT_RULES.codStates.length, 0);
  assert.equal(CLOSED_PAYMENT_RULES.codBulkThreshold, 0);
  // quantity >= 1 always, so a threshold of 0 means "never", not "always".
  assert.equal(decideCod("Lagos", 1, CLOSED_PAYMENT_RULES).allowed, false);
});

test("an unselected state is denied rather than treated as eligible", () => {
  assert.equal(isStateInList("", RULES.codStates), false);
  assert.equal(decideCod("", 1, RULES).allowed, false);
});

test("denialMessage is the string the API returns for the paymentMethod field", () => {
  assert.equal(codPolicyService.denialMessage("Lagos", 1, RULES), null);
  const message = codPolicyService.denialMessage("Rivers", 2, RULES);
  assert.equal(message, decideCod("Rivers", 2, RULES).message);

  const err = new CodNotAvailableError(message!, "state");
  assert.equal(err.reason, "state");
  assert.ok(err instanceof Error);
});

test("publicRules leaks nothing beyond the two customer-facing numbers", () => {
  assert.deepEqual(codPolicyService.publicRules(RULES), {
    codStates: ["Lagos", "Ogun", "Enugu", "Abuja"],
    codBulkThreshold: 5,
  });
});

test("the fail-closed default's bulk message never prints a nonsense ceiling", () => {
  const message = codPolicyService.denialMessage("Lagos", 1, CLOSED_PAYMENT_RULES);
  assert.ok(message, "threshold 0 still denies with a real sentence");
  assert.ok(!message!.includes("up to 0"), "no 'up to 0 items' wording");
  assert.ok(!message!.includes("up to -1"), "no negative wording either");
});
