import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { registerDbDriver } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { normalizePhone } from "../shared/normalizePhone";
import {
  monthlyKpiService,
  lagosMonthKey,
  lagosMonthRange,
  type MonthlyKpiReport,
} from "./monthlyKpiService";
import { adminRoute } from "../routes/admin";
import { ACCESS_EMAIL_HEADER } from "../auth/adminAuth";
import { products, orders, orderStatusHistory } from "../schema";
import * as spamRepo from "../abuse/spamRepo";
import type { Env } from "../env";

const databaseUrl = process.env.KPI_TEST_DATABASE_URL;

test("monthly KPI API, aggregation, snapshots and immutable closed month", {
  skip: !databaseUrl,
}, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => closePools());

  const now = new Date();
  const currentMonth = lagosMonthKey(now);
  const currentRange = lagosMonthRange(currentMonth);
  const previousMonth = lagosMonthKey(new Date(currentRange.from.getTime() - 1));
  const previousRange = lagosMonthRange(previousMonth);
  const productSlug = `kpi-integration-${Date.now()}`;
  const [product] = await db.insert(products).values({
    slug: productSlug,
    name: "KPI integration fixture",
    description: "Disposable KPI integration product",
    price: 150000,
  }).returning();
  let sequence = 0;

  async function createOrder(input: {
    monthDate: Date;
    status: typeof orders.$inferSelect.status;
    phone: string;
    amount?: number;
    paymentMethod?: typeof orders.$inferSelect.paymentMethod;
    address?: string;
  }) {
    sequence += 1;
    const phoneNorm = normalizePhone(input.phone);
    assert.ok(phoneNorm, `fixture phone should be valid: ${input.phone}`);
    const amount = input.amount ?? 150000;
    const createdAt = input.monthDate;
    const [created] = await db.insert(orders).values({
      productId: product.id,
      idempotencyKey: `${productSlug}-${sequence}`,
      customerName: "KPI Integration Fixture",
      phone: input.phone,
      phoneNorm,
      whatsapp: input.phone,
      address: input.address ?? `Address ${sequence}, Lagos`,
      state: "Lagos",
      deliveryFeeType: "free",
      deliveryDate: "today",
      paymentMethod: input.paymentMethod ?? "cod",
      unitPrice: amount,
      subtotal: amount,
      amount,
      reference: `${productSlug}-${sequence}`,
      status: input.status,
      deliveredAt: input.status === "delivered" ? createdAt : null,
      createdAt,
      updatedAt: createdAt,
    }).returning();
    return created.id;
  }

  const day = new Date(previousRange.from.getTime() + 10 * 86_400_000);
  const fixtureOrders: { status: typeof orders.$inferSelect.status; id: number; phone: string }[] = [];
  const statusFixtures: {
    status: typeof orders.$inferSelect.status;
    phone: string;
    time?: Date;
  }[] = [
    { status: "awaiting_payment", phone: "+2348012345001" },
    { status: "failed", phone: "+2348012345002" },
    { status: "confirmed_cod", phone: "+2348012345003" },
    { status: "delivered", phone: "+2348012345004", time: new Date(day.getTime() + 60_000) },
    { status: "paid", phone: "+2348012345004", time: new Date(day.getTime() + 120_000) },
    { status: "not_picking", phone: "+2348012345006" },
    { status: "cancelled", phone: "+2348012345007" },
  ];

  for (const item of statusFixtures) {
    fixtureOrders.push({
      status: item.status,
      phone: item.phone,
      id: await createOrder({
        monthDate: item.time ?? day,
        status: item.status,
        phone: item.phone,
        address: item.phone === "+2348012345004" ? "Shared test address" : undefined,
      }),
    });
  }
  const spamDeliveredId = await createOrder({
    monthDate: day,
    status: "delivered",
    phone: "+2348012345008",
    amount: 999999,
  });
  const spamFailedId = await createOrder({
    monthDate: day,
    status: "failed",
    phone: "+2348012345009",
  });
  await spamRepo.insert(db, {
    phoneNorm: normalizePhone("+2348012345008")!,
    sourceOrderId: spamDeliveredId,
    reason: "Integration fixture spam flag",
    flaggedBy: "integration-test",
  });
  await spamRepo.insert(db, {
    phoneNorm: normalizePhone("+2348012345009")!,
    sourceOrderId: spamFailedId,
    reason: "Integration fixture spam flag",
    flaggedBy: "integration-test",
  });

  const deliveredOrder = fixtureOrders.find((item) => item.status === "delivered")!;
  await db.insert(orderStatusHistory).values({
    orderId: deliveredOrder.id,
    oldStatus: "paid",
    newStatus: "delivered",
    changedBy: "integration-test",
    createdAt: day,
  });

  const currentOrderId = await createOrder({
    monthDate: new Date(currentRange.from.getTime() + 86_400_000),
    status: "awaiting_payment",
    phone: "+2348012345010",
  });

  const closed = await monthlyKpiService.closePreviousMonth(db, now);
  const repeated = await monthlyKpiService.closePreviousMonth(db, now);
  assert.equal(closed.month, previousMonth);
  assert.equal(closed.source, "close");
  assert.equal(repeated.id, closed.id);
  assert.equal(repeated.totalValidOrders, 7);
  assert.equal(repeated.deliveredOrders, 1);
  assert.equal(repeated.deliveredRevenue, 150000);
  assert.equal(repeated.deliveredInMonth, 2);
  assert.equal(repeated.collectedAmount, null);
  assert.equal(repeated.totalOrders, 9);
  assert.equal(repeated.awaitingPaymentOrders, 1);
  assert.equal(repeated.failedOrders, 2);
  assert.equal(repeated.confirmedCodOrders, 1);
  assert.equal(repeated.paidOrders, 1);
  assert.equal(repeated.deliveredStatusOrders, 2);
  assert.equal(repeated.cancelledOrders, 1);
  assert.equal(repeated.notPickingOrders, 1);
  assert.equal(repeated.spamFlaggedOrders, 2);
  assert.equal(repeated.abuseEvidenceOrders, 2);

  const app = new Hono<{ Bindings: Env }>();
  app.route("/admin", adminRoute);
  const env = {
    DATABASE_URL: databaseUrl,
    ADMIN_OPERATORS: "",
    ENVIRONMENT: "sandbox",
  } as unknown as Env;
  const getReport = () => app.fetch(new Request(
    "http://localhost/admin/reports/monthly-kpis?months=3",
    { headers: { [ACCESS_EMAIL_HEADER]: "owner@example.com" } },
  ), env as never);
  const response = await getReport();
  assert.equal(response.status, 200);
  const body = await response.json() as {
    reports: MonthlyKpiReport[];
    collectionAvailable: boolean;
  };
  assert.equal(body.collectionAvailable, false);

  const closedReport = body.reports.find((row) => row.month === previousMonth)!;
  assert.equal(closedReport.snapshot?.source, "close");
  assert.equal(closedReport.totalValidOrders, 7);
  const emptyMonth = lagosMonthKey(new Date(previousRange.from.getTime() - 1));
  const emptyReport = body.reports.find((row) => row.month === emptyMonth);
  // Empty months are no longer surfaced nor snapshotted: the report window
  // clamps to the first order's month, so a pre-launch month with no orders is
  // absent rather than persisted as an all-zero lazy snapshot.
  assert.equal(emptyReport, undefined);
  assert.equal(body.reports.length, 2);
  const liveReport = body.reports.find((row) => row.month === currentMonth)!;
  assert.equal(liveReport.current, true);
  assert.equal(liveReport.totalValidOrders, 1);
  assert.equal(liveReport.collectedAmount, null);

  await createOrder({
    monthDate: new Date(previousRange.from.getTime() + 20 * 86_400_000),
    status: "paid",
    phone: "+2348012345011",
  });
  await createOrder({
    monthDate: new Date(currentRange.from.getTime() + 2 * 86_400_000),
    status: "not_picking",
    phone: "+2348012345012",
  });

  const refreshed = await getReport();
  const refreshedBody = await refreshed.json() as typeof body;
  const immutableClosed = refreshedBody.reports.find((row) => row.month === previousMonth)!;
  const refreshedLive = refreshedBody.reports.find((row) => row.month === currentMonth)!;
  assert.equal(immutableClosed.totalValidOrders, 7);
  assert.equal(immutableClosed.totalOrders, 9);
  assert.equal(refreshedLive.totalValidOrders, 2);
  assert.equal(refreshedLive.notPickingOrders, 1);

  const allFixtureRows = await db.select({ id: orders.id }).from(orders)
    .where(eq(orders.productId, product.id));
  assert.equal(allFixtureRows.length, 12);
  assert.ok(currentOrderId > 0);
});
