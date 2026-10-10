import type { Db } from "../db";
import { sql } from "drizzle-orm";
import { visitorAnalyticsRepo, type VisitorGeo } from "../data/visitorAnalyticsRepo";

const HASH_VERSION_MIN = 1;
const HASH_VERSION_MAX = 32767;
const VISITOR_RETENTION_MONTHS = 13;
const DAILY_WINDOW_DAYS = 30;
const MONTHLY_WINDOW_MONTHS = 12;
const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const YEAR_DEFINITION_VERSION = 1;

export type VisitorKey = {
  hash: string;
  version: number;
};

export function analyticsHashVersion(raw: string | undefined): number {
  const version = Number(raw ?? "1");
  if (!Number.isInteger(version) || version < HASH_VERSION_MIN || version > HASH_VERSION_MAX) {
    throw new Error("ANALYTICS_IP_HMAC_VERSION must be an integer from 1 to 32767");
  }
  return version;
}

export async function hashVisitorIp(ip: string, secret: string): Promise<string> {
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("ANALYTICS_IP_HMAC_SECRET must contain at least 32 bytes");
  }
  if (!ip || ip.length > 64 || /[\r\n]/.test(ip)) {
    throw new Error("The client IP is not valid for visitor hashing");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function visitorGeo(country: string | undefined, region: string | undefined): VisitorGeo {
  const normalizedCountry = country?.trim().toUpperCase();
  const normalizedRegion = region?.trim();
  return {
    country: normalizedCountry && (/^[A-Z]{2}$/.test(normalizedCountry) || normalizedCountry === "T1")
      ? normalizedCountry : null,
    region: normalizedRegion && normalizedRegion.length <= 80 && !/[\u0000-\u001f]/.test(normalizedRegion)
      ? normalizedRegion : null,
  };
}

export function lagosDate(at: Date): string {
  return new Date(at.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function shiftMonth(date: string, months: number): string {
  const [year, month] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function maxDate(one: string, two: string): string {
  return one > two ? one : two;
}

function minDate(one: string, two: string): string {
  return one < two ? one : two;
}

function dateAfter(date: string): string {
  return shiftDate(date, 1);
}

function datesBetweenInclusive(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

function monthsBetweenInclusive(from: string, to: string): string[] {
  const months: string[] = [];
  for (let month = from; month <= to; month = shiftMonth(month, 1)) months.push(month.slice(0, 7));
  return months;
}

export function retentionCutoffDate(today: string): string {
  const [year, month, day] = today.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 - VISITOR_RETENTION_MONTHS, 1));
  const finalDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, finalDay));
  return target.toISOString().slice(0, 10);
}

function startOfYear(year: number): string {
  return `${year}-01-01`;
}

export const visitorAnalyticsService = {
  async recordVisit(
    db: Db,
    ip: string,
    secret: string,
    version: number,
    geo: VisitorGeo,
    at = new Date(),
  ) {
    const ipHash = await hashVisitorIp(ip, secret);
    return this.recordHashedVisit(db, { hash: ipHash, version }, geo, at);
  },

  async recordHashedVisit(
    db: Db,
    key: VisitorKey,
    geo: VisitorGeo,
    at = new Date(),
  ) {
    return visitorAnalyticsRepo.insertVisitorDay(db, {
      ipHash: key.hash,
      hashVersion: key.version,
      ...geo,
      at,
    });
  },

  async warmDatabase(db: Db) {
    return db.select({ ready: sql<number>`1` });
  },

  async report(db: Db, now = new Date(), range: { from: string; to: string } | null = null) {
    const today = lagosDate(now);
    const currentYear = Number(today.slice(0, 4));
    const tomorrow = dateAfter(today);
    const startedOn = await visitorAnalyticsRepo.analyticsStartedOn(db);
    // The daily series is the only day-granular data, and the only part an
    // explicit range touches (pagination + a date filter). The default is the
    // trailing DAILY_WINDOW_DAYS; a range narrows it to [from, to], clamped to
    // the tracking window so a malformed or future-dated range can never invent
    // days. Monthly and yearly are aggregates and are never day-paginated.
    const dailyFrom = range
      ? maxDate(startedOn, range.from)
      : maxDate(startedOn, shiftDate(today, -(DAILY_WINDOW_DAYS - 1)));
    const dailyTo = minDate(today, range ? range.to : today);
    // A window that lies wholly outside the tracked period (before tracking
    // started, or entirely in the future) has no rows at all. It is reported as
    // an EMPTY series echoing the requested window — never collapsed onto a
    // single invented day outside what was actually asked for.
    const windowEmpty = dailyFrom > dailyTo;
    const dailyEnd = windowEmpty ? dailyFrom : dailyTo;
    const dailyRange = windowEmpty && range
      ? { from: range.from, to: dailyTo }
      : { from: dailyFrom, to: dailyEnd };
    const monthlyFrom = maxDate(startedOn, shiftMonth(monthStart(today), -(MONTHLY_WINDOW_MONTHS - 1)));
    const yearStart = startOfYear(currentYear);

    const [dailyRows, monthlyRows, geographyRows] = await Promise.all([
      windowEmpty
        ? Promise.resolve([] as { date: string; visitors: number }[])
        : visitorAnalyticsRepo.dailyVisitorDaysBetween(db, dailyFrom, dateAfter(dailyEnd)),
      visitorAnalyticsRepo.monthlyUniqueVisitorsBetween(db, monthlyFrom, tomorrow),
      windowEmpty
        ? Promise.resolve([] as { country: string | null; region: string | null; visitorDays: number }[])
        : visitorAnalyticsRepo.visitorGeographyBetween(db, dailyFrom, dateAfter(dailyEnd)),
    ]);

    const existingSnapshots = await visitorAnalyticsRepo.yearSnapshots(db);
    const existingYears = new Set(existingSnapshots.map((snapshot) => snapshot.year));
    const yearsToCapture = Array.from(
      { length: Math.max(0, currentYear - Number(startedOn.slice(0, 4))) },
      (_, index) => Number(startedOn.slice(0, 4)) + index,
    ).filter((year) => !existingYears.has(year));

    if (yearsToCapture.length > 0) {
      const [firstYear] = yearsToCapture;
      const closedYearRows = await visitorAnalyticsRepo.yearlyUniqueVisitorsBetween(
        db,
        startOfYear(firstYear),
        yearStart,
      );
      const counts = new Map(closedYearRows.map((row) => [row.year, row.visitors]));
      const takenAt = new Date();
      await visitorAnalyticsRepo.insertYearSnapshots(db, yearsToCapture.map((year) => ({
        year,
        uniqueVisitors: counts.get(year) ?? 0,
        complete: startedOn <= startOfYear(year),
        definitionVersion: YEAR_DEFINITION_VERSION,
        takenAt,
      })));
    }

    const [currentYearRows, snapshots] = await Promise.all([
      visitorAnalyticsRepo.yearlyUniqueVisitorsBetween(db, yearStart, tomorrow),
      visitorAnalyticsRepo.yearSnapshots(db),
    ]);
    const dailyCounts = new Map(dailyRows.map((row) => [row.date, row.visitors]));
    const monthlyCounts = new Map(monthlyRows.map((row) => [row.month, row.visitors]));
    const currentYearCount = currentYearRows.find((row) => row.year === currentYear)?.visitors ?? 0;

    return {
      trackingStartedOn: startedOn,
      today,
      dailyRange,
      daily: windowEmpty
        ? []
        : datesBetweenInclusive(dailyFrom, dailyEnd).map((date) => ({
          date,
          visitors: dailyCounts.get(date) ?? 0,
        })),
      monthly: monthsBetweenInclusive(monthlyFrom, monthStart(today)).map((month) => ({
        month,
        visitors: monthlyCounts.get(month) ?? 0,
      })),
      yearly: [
        { year: currentYear, visitors: currentYearCount, complete: false, current: true },
        ...snapshots.map((snapshot) => ({
          year: snapshot.year,
          visitors: snapshot.uniqueVisitors,
          complete: snapshot.complete,
          current: false,
        })),
      ].sort((one, two) => two.year - one.year),
      geographyApproximate: true,
      geography: geographyRows,
    };
  },

  async pruneExpired(db: Db, now = new Date(), batchSize = 500) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new RangeError("Visitor retention batch size must be between 1 and 500");
    }
    const today = lagosDate(now);
    const cutoff = retentionCutoffDate(today);
    const startedOn = await visitorAnalyticsRepo.analyticsStartedOn(db);
    const currentYear = Number(today.slice(0, 4));
    const existingSnapshots = await visitorAnalyticsRepo.yearSnapshots(db);
    const existingYears = new Set(existingSnapshots.map((snapshot) => snapshot.year));
    const yearsToCapture = Array.from(
      { length: Math.max(0, currentYear - Number(startedOn.slice(0, 4))) },
      (_, index) => Number(startedOn.slice(0, 4)) + index,
    ).filter((year) => !existingYears.has(year));

    if (yearsToCapture.length > 0) {
      const [firstYear] = yearsToCapture;
      const closedYearRows = await visitorAnalyticsRepo.yearlyUniqueVisitorsBetween(
        db,
        startOfYear(firstYear),
        startOfYear(currentYear),
      );
      const counts = new Map(closedYearRows.map((row) => [row.year, row.visitors]));
      const takenAt = new Date();
      await visitorAnalyticsRepo.insertYearSnapshots(db, yearsToCapture.map((year) => ({
        year,
        uniqueVisitors: counts.get(year) ?? 0,
        complete: startedOn <= startOfYear(year),
        definitionVersion: YEAR_DEFINITION_VERSION,
        takenAt,
      })));
    }

    const keys = await visitorAnalyticsRepo.expiredVisitorKeys(db, cutoff, batchSize);
    const deleted = await visitorAnalyticsRepo.deleteVisitorKeys(db, keys);
    return { cutoff, deleted: deleted.length, morePending: deleted.length === batchSize };
  },
};
