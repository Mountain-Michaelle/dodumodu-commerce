import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryService } from "./deliveryService";

// WAT = UTC+1. 15:00 WAT == 14:00 UTC.
test("excludes 'today' at exactly 15:00 WAT", () => {
  const now = new Date(Date.UTC(2026, 0, 1, 14, 0, 0));
  assert.deepEqual(deliveryService.getDeliveryOptions(now), ["tomorrow", "next_tomorrow"]);
});

test("includes 'today' at 14:59 WAT", () => {
  const now = new Date(Date.UTC(2026, 0, 1, 13, 59, 0));
  assert.deepEqual(deliveryService.getDeliveryOptions(now), ["today", "tomorrow", "next_tomorrow"]);
});

test("flags a late 'today' submission instead of rejecting it", () => {
  const afterCutoff = new Date(Date.UTC(2026, 0, 1, 14, 0, 0));
  const result = deliveryService.validateSubmittedDate(afterCutoff, "today");
  assert.equal(result.accepted, true);
  assert.equal(result.flaggedLate, true);
});

test("does not flag a valid 'tomorrow' submission after cutoff", () => {
  const afterCutoff = new Date(Date.UTC(2026, 0, 1, 14, 0, 0));
  const result = deliveryService.validateSubmittedDate(afterCutoff, "tomorrow");
  assert.equal(result.flaggedLate, false);
});

test("Lagos and Ogun get free delivery, everything else gets waybill", () => {
  assert.equal(deliveryService.getDeliveryFee("Lagos"), "free");
  assert.equal(deliveryService.getDeliveryFee("Ogun"), "free");
  assert.equal(deliveryService.getDeliveryFee("Kano"), "waybill");
  assert.equal(deliveryService.getDeliveryFee("Rivers"), "waybill");
});

test("free delivery matching survives the spellings customers actually type", () => {
  assert.equal(deliveryService.getDeliveryFee("lagos"), "free");
  assert.equal(deliveryService.getDeliveryFee("  Lagos  "), "free");
  assert.equal(deliveryService.getDeliveryFee("Ogun State"), "free");
  assert.equal(deliveryService.getDeliveryFee("Enugu"), "waybill");
  assert.equal(deliveryService.getDeliveryFee(""), "waybill");
});

