import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateOrdersByMonth,
  isKpiCohortOrder,
  lagosMonthKey,
  lagosMonthRange,
} from "./monthlyKpiService";

type ReportOrder = Parameters<typeof aggregateOrdersByMonth>[0][number];

function order(overrides: Partial<ReportOrder> = {}): ReportOrder {
  return {
    id: 1,
    reference: `ord-${overrides.id ?? 1}`,
    createdAt: new Date("2026-09-15T10:00:00Z"),
    status: "awaiting_payment",
    paymentMethod: "cod",
    amount: 150000,
    deliveredAt: null,
    phone: "+2348012345678",
    phoneNorm: "+2348012345678",
    address: "12 Allen Avenue",
    productId: 1,
    quantity: 1,
    ...overrides,
  };
}

test("the Lagos month starts at 23:00 UTC on the prior calendar day", () => {
  const { from, to } = lagosMonthRange("2026-10");
  assert.equal(from.toISOString(), "2026-09-30T23:00:00.000Z");
  assert.equal(to.toISOString(), "2026-10-31T23:00:00.000Z");
  assert.equal(lagosMonthKey(new Date("2026-10-31T23:00:00Z")), "2026-11");
  assert.equal(lagosMonthKey(new Date("2026-10-31T22:59:59.999Z")), "2026-10");
});

test("all non-spam statuses count in the cohort and spam orders count in no rate side", () => {
  const statuses: ReportOrder["status"][] = [
    "awaiting_payment", "failed", "confirmed_cod", "paid", "delivered", "not_picking", "cancelled",
  ];
  const nonSpam = statuses.map((status, index) => order({
    id: index + 1,
    reference: `real-${index}`,
    status,
    phone: `+23480${String(index + 1).padStart(8, "0")}`,
  }));
  const spamDelivered = order({
    id: 8,
    reference: "spam-delivered",
    status: "delivered",
    phone: "+2348098765432",
    amount: 999999,
  });
  const spamFailed = order({
    id: 9,
    reference: "spam-failed",
    status: "failed",
    phone: "+2348087654321",
  });

  const metrics = aggregateOrdersByMonth(
    [...nonSpam, spamDelivered, spamFailed],
    new Set(["+2348098765432", "+2348087654321"]),
  ).get("2026-09")!;

  assert.equal(metrics.totalOrders, 9);
  assert.equal(metrics.totalValidOrders, 7);
  assert.equal(metrics.deliveredOrders, 1);
  assert.equal(metrics.deliveredRevenue, 150000);
  assert.equal(metrics.deliveredStatusOrders, 2);
  assert.equal(metrics.awaitingPaymentOrders, 1);
  assert.equal(metrics.failedOrders, 2);
  assert.equal(metrics.confirmedCodOrders, 1);
  assert.equal(metrics.paidOrders, 1);
  assert.equal(metrics.cancelledOrders, 1);
  assert.equal(metrics.notPickingOrders, 1);
  assert.equal(metrics.spamFlaggedOrders, 2);
  assert.equal(metrics.collectedAmount, null);
});

test("the cohort predicate is independent of lifecycle status", () => {
  assert.equal(isKpiCohortOrder(false), true);
  assert.equal(isKpiCohortOrder(true), false);
});
