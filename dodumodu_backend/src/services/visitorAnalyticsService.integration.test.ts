import { test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { registerDbDriver } from "../db";
import { closePools, pgDriver } from "../dbDrivers/pg";
import { visitorDays, visitorYearSnapshots } from "../schema";
import { hashVisitorIp, visitorAnalyticsService } from "./visitorAnalyticsService";

const databaseUrl = process.env.VISITOR_TEST_DATABASE_URL;
const SECRET = "visitor-analytics-integration-key-0123456789";

test("visitor writes, distinct reports, geography, annual snapshots and bounded retention", {
  skip: !databaseUrl,
}, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => closePools());

  const ipA = "203.0.113.31";
  const ipB = "203.0.113.32";
  const ipC = "203.0.113.33";
  const ipD = "203.0.113.34";
  const version = 1;
  const geo = { country: "NG", region: "Lagos" };

  // Deterministic start state. started_on is stamped with the day the migration ran,
  // so without pinning it this test only passed on a DB migrated on 2026-10-08, and
  // it also assumes empty tables. This test deletes rows: local databases only.
  const host = new URL(databaseUrl!).hostname;
  // Local, or a remote host the operator named EXACTLY in ALLOW_REMOTE_TEST_DB (a disposable
  // branch) - the same explicit opt-in scripts/require-test-db.mjs demands.
  assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || process.env.ALLOW_REMOTE_TEST_DB === host,
    `refusing to reset visitor tables on non-local host "${host}" (set ALLOW_REMOTE_TEST_DB=${host} only for a disposable database)`);
  await db.execute(sql`DELETE FROM visitor_days`);
  await db.execute(sql`DELETE FROM visitor_year_snapshots`);
  await db.execute(sql`UPDATE visitor_analytics_meta SET started_on = '2026-10-08'`);

  const firstDay = new Date("2026-10-08T22:59:59.000Z");
  const sameLagosDay = new Date("2026-10-08T21:00:00.000Z");
  const nextLagosDay = new Date("2026-10-08T23:00:00.000Z");
  await visitorAnalyticsService.recordVisit(db, ipA, SECRET, version, geo, firstDay);
  await visitorAnalyticsService.recordVisit(db, ipA, SECRET, version, geo, sameLagosDay);
  await visitorAnalyticsService.recordVisit(db, ipA, SECRET, version, geo, nextLagosDay);
  await visitorAnalyticsService.recordVisit(db, ipB, SECRET, version, geo, sameLagosDay);

  const identityRows = await db.select().from(visitorDays)
    .where(eq(visitorDays.ipHash, await hashVisitorIp(ipA, SECRET)));
  assert.deepEqual(identityRows.map((row) => row.visitDate).sort(), ["2026-10-08", "2026-10-09"]);
  assert.ok(identityRows.every((row) => !JSON.stringify(row).includes(ipA)));
  assert.equal((await db.select().from(visitorDays)).length, 3);

  await visitorAnalyticsService.recordVisit(
    db, ipC, SECRET, version, geo, new Date("2027-01-15T12:00:00.000Z"),
  );
  await visitorAnalyticsService.recordVisit(
    db, ipC, SECRET, version, geo, new Date("2027-01-20T12:00:00.000Z"),
  );
  await visitorAnalyticsService.recordVisit(
    db, ipD, SECRET, version, geo, new Date("2027-01-20T12:00:00.000Z"),
  );
  await visitorAnalyticsService.recordVisit(
    db, ipC, SECRET, version, geo, new Date("2027-02-02T12:00:00.000Z"),
  );
  await visitorAnalyticsService.recordVisit(
    db, ipB, SECRET, version, { country: "NG", region: "FCT" },
    new Date("2027-03-15T12:00:00.000Z"),
  );

  const report = await visitorAnalyticsService.report(db, new Date("2027-03-15T10:00:00.000Z"));
  assert.equal(report.trackingStartedOn, "2026-10-08");
  assert.deepEqual(report.monthly.find((row) => row.month === "2027-01"), {
    month: "2027-01",
    visitors: 2,
  });
  assert.deepEqual(report.monthly.find((row) => row.month === "2027-02"), {
    month: "2027-02",
    visitors: 1,
  });
  assert.equal(report.monthly.find((row) => row.month === "2026-11")?.visitors, 0);
  assert.equal(report.daily.find((row) => row.date === "2027-03-15")?.visitors, 1);
  assert.equal(report.geographyApproximate, true);
  assert.ok(report.geography.some((row) => row.country === "NG" && row.region === "FCT"));

  const currentYear = report.yearly.find((row) => row.year === 2027)!;
  const priorYear = report.yearly.find((row) => row.year === 2026)!;
  assert.equal(currentYear.visitors, 3);
  assert.equal(currentYear.current, true);
  assert.equal(priorYear.visitors, 2);
  assert.equal(priorYear.complete, false);
  assert.equal(priorYear.current, false);

  const pruneNow = new Date("2028-04-10T10:00:00.000Z");
  const firstPrune = await visitorAnalyticsService.pruneExpired(db, pruneNow, 1);
  assert.equal(firstPrune.cutoff, "2027-03-10");
  assert.equal(firstPrune.deleted, 1);
  assert.equal(firstPrune.morePending, true);
  const afterFirstBatch = await db.select().from(visitorDays);
  assert.equal(afterFirstBatch.length, 7);

  const annualRows = await db.select().from(visitorYearSnapshots);
  const snapshot2027 = annualRows.find((row) => row.year === 2027)!;
  assert.equal(snapshot2027.uniqueVisitors, 3);
  assert.equal(snapshot2027.complete, true);

  const secondPrune = await visitorAnalyticsService.pruneExpired(db, pruneNow, 500);
  assert.ok(secondPrune.deleted >= 1);
  const repeatedPrune = await visitorAnalyticsService.pruneExpired(db, pruneNow, 500);
  assert.equal(repeatedPrune.deleted, 0);
  assert.equal(repeatedPrune.morePending, false);

  const reportAfterPrune = await visitorAnalyticsService.report(db, pruneNow);
  assert.deepEqual(reportAfterPrune.yearly.find((row) => row.year === 2027), {
    year: 2027,
    visitors: 3,
    complete: true,
    current: false,
  });
});
