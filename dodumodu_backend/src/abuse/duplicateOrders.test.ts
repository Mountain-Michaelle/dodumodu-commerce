import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicates, type CandidateOrder, type NewOrderFacts } from "./duplicateOrders";

const T0 = new Date("2026-11-17T10:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const order = (over: Partial<NewOrderFacts> = {}): NewOrderFacts => ({
  productId: 1, phone: "08031234567", whatsapp: "08031234567", customerName: "Ada Obi", address: "12 Allen Avenue, Ikeja", createdAt: minutes(30), ...over,
});
const cand = (over: Partial<CandidateOrder> = {}): CandidateOrder => ({
  id: 7, reference: "ddmd-aaaa", productId: 1, phone: "08031234567", whatsapp: "08031234567", customerName: "Ada Obi", address: "12 Allen Avenue, Ikeja",
  status: "confirmed_cod", createdAt: T0, ...over,
});

test("the same person ordering again minutes later is a probable duplicate, with a reference to the earlier order", () => {
  const refs = findDuplicates(order({ createdAt: minutes(4) }), [cand()]);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0], { id: 7, reference: "ddmd-aaaa", reason: "same_number_and_name", minutesApart: 4 });
});

test("the same number is recognised however it is written (+234, 234, 0803, spaces)", () => {
  assert.equal(findDuplicates(order({ phone: "+234 803 123 4567", whatsapp: "+234 803 123 4567", customerName: "Someone Else", address: "Elsewhere" , createdAt: minutes(5) }), [cand({ customerName: "X Y", address: "Z" })]).length, 1);
});

test("a WhatsApp number that matches the earlier PHONE counts as the same person", () => {
  const refs = findDuplicates(order({ phone: "08099999999", whatsapp: "08031234567", customerName: "Different", address: "Different", createdAt: minutes(3) }), [cand()]);
  assert.equal(refs[0]?.reason, "same_number_within_minutes");
});

test("a LEGITIMATE repeat purchase is not flagged: the earlier order was delivered, cancelled or failed", () => {
  for (const status of ["delivered", "cancelled", "failed"]) {
    assert.deepEqual(findDuplicates(order({ createdAt: minutes(5) }), [cand({ status })]), [], status);
  }
});

test("a different product is never a duplicate", () => {
  assert.deepEqual(findDuplicates(order({ createdAt: minutes(5) }), [cand({ productId: 2 })]), []);
});

test("an order from the previous day or earlier is a repeat purchase, not a duplicate", () => {
  assert.deepEqual(findDuplicates(order({ createdAt: new Date(T0.getTime() + 25 * 3_600_000) }), [cand()]), []);
});

test("the same number hours later with a different name and address (a gift, a household) is NOT flagged", () => {
  assert.deepEqual(findDuplicates(order({ customerName: "Chidi Eze", address: "4 Other Street", createdAt: minutes(300) }), [cand()]), []);
});

test("the same number hours later with the SAME name is flagged for review (still open, still same product)", () => {
  assert.equal(findDuplicates(order({ createdAt: minutes(300) }), [cand()])[0]?.reason, "same_number_and_name");
});

test("same name AND address under a different number is flagged; a common name alone is not", () => {
  assert.equal(findDuplicates(order({ phone: "08055555555", whatsapp: "08055555555", createdAt: minutes(60) }), [cand()])[0]?.reason, "same_name_and_address");
  assert.deepEqual(findDuplicates(order({ phone: "08055555555", whatsapp: "08055555555", address: "Another place", createdAt: minutes(60) }), [cand()]), []);
});

test("capitalisation, punctuation and spacing do not hide a duplicate", () => {
  assert.equal(findDuplicates(order({ customerName: "  ADA   obi ", address: "12, allen avenue ikeja!", createdAt: minutes(20) }), [cand()]).length, 1);
});

test("an order cannot be a duplicate of one that came AFTER it, and blanks never match each other", () => {
  assert.deepEqual(findDuplicates(order({ createdAt: minutes(-5) }), [cand()]), []);
  assert.deepEqual(findDuplicates(order({ phone: "x", whatsapp: "y", customerName: "", address: "", createdAt: minutes(5) }), [cand({ phone: "z", whatsapp: "w", customerName: "", address: "" })]), []);
});

test("references are most recent first and bounded", () => {
  const many = Array.from({ length: 9 }, (_, i) => cand({ id: 100 + i, reference: `r${i}`, createdAt: minutes(i) }));
  const refs = findDuplicates(order({ createdAt: minutes(20) }), many);
  assert.equal(refs.length, 5);
  assert.deepEqual(refs.map((r) => r.id), [108, 107, 106, 105, 104]);
});
