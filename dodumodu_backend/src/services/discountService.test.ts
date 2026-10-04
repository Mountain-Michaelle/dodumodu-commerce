import { test } from "node:test";
import assert from "node:assert/strict";
import { discountService } from "./discountService";

// Mirrors the seed data from migrations/0001_quantity_discounts.sql.
const SEED_TIERS = [
  { minQuantity: 1, discountPercent: 0, active: true },
  { minQuantity: 2, discountPercent: 10, active: true },
  { minQuantity: 3, discountPercent: 20, active: true },
  { minQuantity: 5, discountPercent: 25, active: true },
];

test("quantity 1 resolves to 0%", () => {
  assert.equal(discountService.resolveDiscountPercent(1, SEED_TIERS), 0);
});

test("quantity 2 resolves to 10%", () => {
  assert.equal(discountService.resolveDiscountPercent(2, SEED_TIERS), 10);
});

test("quantity 3 and 4 both resolve to 20% (tier boundary covers the range)", () => {
  assert.equal(discountService.resolveDiscountPercent(3, SEED_TIERS), 20);
  assert.equal(discountService.resolveDiscountPercent(4, SEED_TIERS), 20);
});

test("quantity 5 and 11 both resolve to 25%", () => {
  assert.equal(discountService.resolveDiscountPercent(5, SEED_TIERS), 25);
  assert.equal(discountService.resolveDiscountPercent(11, SEED_TIERS), 25);
});

test("an inactive tier is skipped even if its min_quantity would otherwise apply", () => {
  const tiersWithInactive5 = SEED_TIERS.map((t) => (t.minQuantity === 5 ? { ...t, active: false } : t));
  assert.equal(discountService.resolveDiscountPercent(11, tiersWithInactive5), 20);
});

test("computePriceBreakdown applies the §8.8 rounding rule consistently", () => {
  const result = discountService.computePriceBreakdown(29500_00 / 100, 3, SEED_TIERS); // unit price in kobo-ish demo units
  assert.equal(result.quantity, 3);
  assert.equal(result.discountPercent, 20);
  assert.equal(result.subtotal, result.unitPrice * 3);
  assert.equal(result.discountAmount, Math.round((result.subtotal * 20) / 100));
  assert.equal(result.amount, result.subtotal - result.discountAmount);
});

test("no discount when no tier applies (quantity below every active minQuantity)", () => {
  const tiersStartingAt2 = SEED_TIERS.filter((t) => t.minQuantity !== 1);
  assert.equal(discountService.resolveDiscountPercent(1, tiersStartingAt2), 0);
});
