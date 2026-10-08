import { evidenceForOrders } from "../abuse/orderEvidence";
import * as spamRepo from "../abuse/spamRepo";
import { monthlyKpiRepo } from "../data/monthlyKpiRepo";
import type { Db } from "../db";
import type { monthlyKpiSnapshots } from "../schema";
import { normalizePhone } from "../shared/normalizePhone";

const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const MAX_MONTHS = 24;
const DEFINITION_VERSION = 1;

type MonthRange = { month: string; from: Date; to: Date };
type Snapshot = typeof monthlyKpiSnapshots.$inferSelect;
type Order = Awaited<ReturnType<typeof monthlyKpiRepo.ordersBetween>>[number];
type Status = Order["status"];

export type KpiMetrics = Pick<Snapshot,
  | "totalValidOrders"
  | "deliveredOrders"
  | "deliveredRevenue"
  | "deliveredInMonth"
  | "collectedAmount"
  | "totalOrders"
  | "awaitingPaymentOrders"
  | "paidOrders"
  | "failedOrders"
  | "confirmedCodOrders"
  | "deliveredStatusOrders"
  | "cancelledOrders"
  | "notPickingOrders"
  | "spamFlaggedOrders"
  | "abuseEvidenceOrders"
  | "payNowOrders"
  | "codOrders"
>;

export type MonthlyKpiReport = KpiMetrics & {
  month: string;
  current: boolean;
  snapshot: null | {
    source: string;
    takenAt: Date;
    takenBy: string | null;
    definitionVersion: number;
  };
};

const STATUS_FIELDS: Record<Status, keyof KpiMetrics> = {
  awaiting_payment: "awaitingPaymentOrders",
  paid: "paidOrders",
  failed: "failedOrders",
  confirmed_cod: "confirmedCodOrders",
  delivered: "deliveredStatusOrders",
  cancelled: "cancelledOrders",
  not_picking: "notPickingOrders",
};

function emptyMetrics(): KpiMetrics {
  return {
    totalValidOrders: 0,
    deliveredOrders: 0,
    deliveredRevenue: 0,
    deliveredInMonth: 0,
    collectedAmount: null,
    totalOrders: 0,
    awaitingPaymentOrders: 0,
    paidOrders: 0,
    failedOrders: 0,
    confirmedCodOrders: 0,
    deliveredStatusOrders: 0,
    cancelledOrders: 0,
    notPickingOrders: 0,
    spamFlaggedOrders: 0,
    abuseEvidenceOrders: 0,
    payNowOrders: 0,
    codOrders: 0,
  };
}

/** No test-order marker exists, so every stored order is real; only active spam flags exclude it. */
export function isKpiCohortOrder(spamFlagged: boolean): boolean {
  return !spamFlagged;
}

export function lagosMonthKey(at: Date): string {
  const shifted = new Date(at.getTime() + LAGOS_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function lagosMonthRange(month: string): MonthRange {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new Error(`Invalid KPI month: ${month}`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    month,
    from: new Date(Date.UTC(year, monthIndex, 1) - LAGOS_OFFSET_MS),
    to: new Date(Date.UTC(year, monthIndex + 1, 1) - LAGOS_OFFSET_MS),
  };
}

function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthRanges(months: string[]): MonthRange[] {
  return months.map(lagosMonthRange);
}

function monthKeysEndingAt(monthCount: number, now: Date): string[] {
  if (!Number.isInteger(monthCount) || monthCount < 1 || monthCount > MAX_MONTHS) {
    throw new RangeError(`months must be an integer between 1 and ${MAX_MONTHS}`);
  }
  const current = lagosMonthKey(now);
  return Array.from({ length: monthCount }, (_, index) => shiftMonth(current, index - monthCount + 1));
}

function addStatusMetric(metrics: KpiMetrics, status: Status): void {
  const field = STATUS_FIELDS[status];
  metrics[field] = Number(metrics[field]) + 1;
}

export function aggregateOrdersByMonth(
  ordersInRange: Order[],
  activePhones: Set<string>,
): Map<string, KpiMetrics> {
  const result = new Map<string, KpiMetrics>();
  for (const order of ordersInRange) {
    const month = lagosMonthKey(order.createdAt);
    const metrics = result.get(month) ?? emptyMetrics();
    result.set(month, metrics);
    const phoneNorm = normalizePhone(order.phone);
    const spamFlagged = phoneNorm !== null && activePhones.has(phoneNorm);

    metrics.totalOrders += 1;
    addStatusMetric(metrics, order.status);
    if (spamFlagged) metrics.spamFlaggedOrders += 1;
    if (order.paymentMethod === "pay_now") metrics.payNowOrders += 1;
    else metrics.codOrders += 1;

    if (isKpiCohortOrder(spamFlagged)) {
      metrics.totalValidOrders += 1;
      if (order.status === "delivered") {
        metrics.deliveredOrders += 1;
        metrics.deliveredRevenue += order.amount;
      }
    }
  }
  return result;
}

async function calculateMetrics(db: Db, months: string[]): Promise<Map<string, KpiMetrics>> {
  const result = new Map(months.map((month) => [month, emptyMetrics()]));
  if (months.length === 0) return result;

  const ranges = monthRanges(months);
  const from = ranges[0].from;
  const to = ranges[ranges.length - 1].to;
  const [ordersInRange, activePhones, deliveryEvents, currentDeliveries] = await Promise.all([
    monthlyKpiRepo.ordersBetween(db, from, to),
    spamRepo.activePhoneNorms(db),
    monthlyKpiRepo.deliveryEventsBetween(db, from, to),
    monthlyKpiRepo.currentlyDeliveredBetween(db, from, to),
  ]);
  const selectedMonths = new Set(months);
  const scopedOrders = ordersInRange.filter((order) => selectedMonths.has(lagosMonthKey(order.createdAt)));
  const evidence = await evidenceForOrders(db, scopedOrders);
  const orderMetrics = aggregateOrdersByMonth(scopedOrders, activePhones);
  for (const [month, orderMetric] of orderMetrics) {
    result.set(month, orderMetric);
  }

  for (const order of scopedOrders) {
    const month = lagosMonthKey(order.createdAt);
    const metrics = result.get(month);
    if (!metrics) continue;
    const orderEvidence = evidence.get(order.id);
    if (orderEvidence?.duplicateOf || orderEvidence?.reordering) {
      metrics.abuseEvidenceOrders += 1;
    }
  }

  const deliveriesByMonth = new Map<string, Set<number>>();
  for (const event of deliveryEvents) {
    const month = lagosMonthKey(event.createdAt);
    if (!selectedMonths.has(month)) continue;
    const ordersForMonth = deliveriesByMonth.get(month) ?? new Set<number>();
    ordersForMonth.add(event.orderId);
    deliveriesByMonth.set(month, ordersForMonth);
  }
  for (const delivery of currentDeliveries) {
    if (!delivery.deliveredAt) continue;
    const month = lagosMonthKey(delivery.deliveredAt);
    if (!selectedMonths.has(month)) continue;
    const ordersForMonth = deliveriesByMonth.get(month) ?? new Set<number>();
    ordersForMonth.add(delivery.id);
    deliveriesByMonth.set(month, ordersForMonth);
  }
  for (const [month, delivered] of deliveriesByMonth) {
    const metrics = result.get(month);
    if (metrics) metrics.deliveredInMonth = delivered.size;
  }

  return result;
}

function snapshotValue(
  month: string,
  metrics: KpiMetrics,
  source: "close" | "lazy",
  takenAt: Date,
  takenBy: string | null,
) {
  return {
    month,
    ...metrics,
    source,
    definitionVersion: DEFINITION_VERSION,
    takenAt,
    takenBy,
  };
}

function reportFromSnapshot(snapshot: Snapshot): MonthlyKpiReport {
  const {
    id: _id,
    month,
    source,
    definitionVersion,
    takenAt,
    takenBy,
    createdAt: _createdAt,
    ...metrics
  } = snapshot;
  return {
    ...metrics,
    month,
    current: false,
    snapshot: { source, takenAt, takenBy, definitionVersion },
  };
}

export const monthlyKpiService = {
  async report(
    db: Db,
    monthCount: number,
    now = new Date(),
    takenBy: string | null = null,
  ): Promise<MonthlyKpiReport[]> {
    const months = monthKeysEndingAt(monthCount, now);
    const currentMonth = lagosMonthKey(now);
    const existing = await monthlyKpiRepo.snapshotsForMonths(db, months);
    const byMonth = new Map(existing.map((snapshot) => [snapshot.month, snapshot]));
    const toCalculate = months.filter((month) => month === currentMonth || !byMonth.has(month));
    const metrics = await calculateMetrics(db, toCalculate);
    const takenAt = new Date();
    const missingClosed = toCalculate.filter((month) => month !== currentMonth);

    await monthlyKpiRepo.insertSnapshots(db, missingClosed.map((month) =>
      snapshotValue(month, metrics.get(month)!, "lazy", takenAt, takenBy)));

    const afterInsert = await monthlyKpiRepo.snapshotsForMonths(db, missingClosed);
    for (const snapshot of afterInsert) byMonth.set(snapshot.month, snapshot);

    return months.map((month) => {
      if (month !== currentMonth) {
        const snapshot = byMonth.get(month);
        if (!snapshot) throw new Error(`Monthly KPI snapshot was not persisted for ${month}`);
        return reportFromSnapshot(snapshot);
      }
      return {
        ...metrics.get(month)!,
        month,
        current: true,
        snapshot: null,
      };
    });
  },

  async closePreviousMonth(db: Db, now = new Date()) {
    const previousMonth = shiftMonth(lagosMonthKey(now), -1);
    const [existing] = await monthlyKpiRepo.snapshotsForMonths(db, [previousMonth]);
    if (existing) return existing;

    const metrics = await calculateMetrics(db, [previousMonth]);
    const [value] = await monthlyKpiRepo.insertSnapshots(db, [
      snapshotValue(previousMonth, metrics.get(previousMonth)!, "close", new Date(), null),
    ]);
    if (value) return value;
    const [winner] = await monthlyKpiRepo.snapshotsForMonths(db, [previousMonth]);
    if (!winner) throw new Error(`Monthly KPI snapshot was not persisted for ${previousMonth}`);
    return winner;
  },
};
