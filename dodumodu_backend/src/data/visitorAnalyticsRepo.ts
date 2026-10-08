import { and, asc, count, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { visitorAnalyticsMeta, visitorDays, visitorYearSnapshots } from "../schema";

export type VisitorHash = {
  ipHash: string;
  hashVersion: number;
};

export type VisitorGeo = {
  country: string | null;
  region: string | null;
};

export type ExpiredVisitorKey = VisitorHash & { visitDate: string };

export const visitorAnalyticsRepo = {
  async insertVisitorDay(
    db: Db,
    input: VisitorHash & VisitorGeo & { at: Date },
  ) {
    return db.insert(visitorDays).values({
      visitDate: sql`(${input.at}::timestamptz AT TIME ZONE 'Africa/Lagos')::date`,
      ipHash: input.ipHash,
      hashVersion: input.hashVersion,
      country: input.country,
      region: input.region,
    }).onConflictDoNothing({
      target: [visitorDays.visitDate, visitorDays.hashVersion, visitorDays.ipHash],
    }).returning();
  },

  async analyticsStartedOn(db: Db) {
    const [row] = await db.select({ startedOn: visitorAnalyticsMeta.startedOn })
      .from(visitorAnalyticsMeta)
      .where(eq(visitorAnalyticsMeta.id, 1))
      .limit(1);
    if (!row) throw new Error("Visitor analytics start date is missing");
    return row.startedOn;
  },

  async dailyVisitorDaysBetween(db: Db, from: string, to: string) {
    return db.select({
      date: visitorDays.visitDate,
      visitors: count(),
    }).from(visitorDays)
      .where(and(gte(visitorDays.visitDate, from), lt(visitorDays.visitDate, to)))
      .groupBy(visitorDays.visitDate)
      .orderBy(asc(visitorDays.visitDate));
  },

  async monthlyUniqueVisitorsBetween(db: Db, from: string, to: string) {
    const month = sql<string>`to_char(${visitorDays.visitDate}, 'YYYY-MM')`;
    const visitors = sql<number>`
      count(distinct row(${visitorDays.hashVersion}, ${visitorDays.ipHash}))::integer
    `;
    return db.select({ month, visitors }).from(visitorDays)
      .where(and(gte(visitorDays.visitDate, from), lt(visitorDays.visitDate, to)))
      .groupBy(month)
      .orderBy(month);
  },

  async yearlyUniqueVisitorsBetween(db: Db, from: string, to: string) {
    const year = sql<number>`extract(year from ${visitorDays.visitDate})::integer`;
    const visitors = sql<number>`
      count(distinct row(${visitorDays.hashVersion}, ${visitorDays.ipHash}))::integer
    `;
    return db.select({ year, visitors }).from(visitorDays)
      .where(and(gte(visitorDays.visitDate, from), lt(visitorDays.visitDate, to)))
      .groupBy(year)
      .orderBy(year);
  },

  async visitorGeographyBetween(db: Db, from: string, to: string) {
    const visitorDaysCount = count();
    return db.select({
      country: visitorDays.country,
      region: visitorDays.region,
      visitorDays: visitorDaysCount,
    }).from(visitorDays)
      .where(and(
        gte(visitorDays.visitDate, from),
        lt(visitorDays.visitDate, to),
        sql`(${visitorDays.country} IS NOT NULL OR ${visitorDays.region} IS NOT NULL)`,
      ))
      .groupBy(visitorDays.country, visitorDays.region)
      .orderBy(desc(visitorDaysCount), asc(visitorDays.country), asc(visitorDays.region))
      .limit(10);
  },

  async yearSnapshots(db: Db) {
    return db.select().from(visitorYearSnapshots)
      .orderBy(desc(visitorYearSnapshots.year));
  },

  async insertYearSnapshots(
    db: Db,
    rows: (typeof visitorYearSnapshots.$inferInsert)[],
  ) {
    if (rows.length === 0) return [];
    return db.insert(visitorYearSnapshots).values(rows)
      .onConflictDoNothing({ target: visitorYearSnapshots.year })
      .returning();
  },

  async expiredVisitorKeys(db: Db, before: string, limit: number) {
    return db.select({
      visitDate: visitorDays.visitDate,
      hashVersion: visitorDays.hashVersion,
      ipHash: visitorDays.ipHash,
    }).from(visitorDays)
      .where(lt(visitorDays.visitDate, before))
      .orderBy(asc(visitorDays.visitDate), asc(visitorDays.hashVersion), asc(visitorDays.ipHash))
      .limit(limit);
  },

  async deleteVisitorKeys(db: Db, keys: ExpiredVisitorKey[]) {
    if (keys.length === 0) return [];
    return db.delete(visitorDays).where(or(...keys.map((key) => and(
      eq(visitorDays.visitDate, key.visitDate),
      eq(visitorDays.hashVersion, key.hashVersion),
      eq(visitorDays.ipHash, key.ipHash),
    )))).returning();
  },
};
