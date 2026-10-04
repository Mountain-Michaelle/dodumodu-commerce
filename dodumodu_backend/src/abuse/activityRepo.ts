import { sql, and, eq, desc, lt } from "drizzle-orm";
import type { Db } from "../db";
import { abuseIpWindows, abuseIpPhones, abuseObservations } from "../schema";
import type { EstablishedEvidence } from "./counters";

// Reading and recording abuse observations.
//
// THE CONCURRENCY REQUIREMENT, and the reason this file exists rather than more
// in-memory counting:
//
//   A counter that is read, incremented in JavaScript and written back loses
//   counts under concurrency. Two requests both read 4, both write 5, and one
//   increment disappears. That is not a theoretical problem here: it was exactly
//   the bug in the KV limiter this replaces, where the free tier allows one write
//   per second per key and a burst silently under-counts - meaning a flooder is
//   under-counted precisely when the count matters.
//
// So every increment is a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
// statement. The database applies them serially on the row, so N concurrent
// requests produce exactly N increments. There is no read-then-write anywhere in
// this file.

/** What a single upsert returns: the counters as they now stand. */
type WindowCounts = typeof abuseIpWindows.$inferSelect;

/**
 * Record one order POST and return the counters for this IP's window.
 *
 * One statement, so the returned row already includes THIS request. Callers that
 * need to make a decision must therefore use the row they read BEFORE calling
 * this - see guardService, which does exactly that and never judges a request on
 * the numbers this call just produced.
 */
export async function recordPost(db: Db, ip: string, windowStart: number) {
  const [row] = await db
    .insert(abuseIpWindows)
    .values({ ip, windowStart, posts: 1 })
    .onConflictDoUpdate({
      target: [abuseIpWindows.ip, abuseIpWindows.windowStart],
      set: {
        posts: sql`${abuseIpWindows.posts} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/**
 * Same atomic shape as recordPost, for the other outcome counters.
 *
 * WHY THIS IS NOT WRITTEN THE OBVIOUS WAY. The first version built the row with a
 * computed key - `.values({ ip, windowStart, [columnName(column)]: 1 })` and the
 * same key in `.set()`. That reads correctly and it silently does nothing: drizzle
 * resolves `.values()` and `.set()` against the table's known keys at call time, so
 * an unknown computed key is dropped rather than rejected, and the statement came
 * out as `values (..., default, default, default, default)` with no SET clause for
 * the counter at all. Every unit test still passed, because they assert against a
 * stub database that never renders SQL - the bug was invisible until this ran
 * against real Postgres, where validation_failures, turnstile_failures and
 * successful_progressions were all permanently zero.
 *
 * So the column is now chosen with an explicit branch and passed as a real
 * drizzle column, not as a string. There are four counters; a switch is honest
 * about that, and it cannot fail open in silence again.
 */
async function bump(
  db: Db,
  ip: string,
  windowStart: number,
  column: typeof abuseIpWindows.posts | typeof abuseIpWindows.validationFailures
  | typeof abuseIpWindows.turnstileFailures | typeof abuseIpWindows.successfulProgressions,
) {
  // The whole statement is built as raw SQL rather than through the query builder.
  //
  // The builder cannot express this correctly here. drizzle resolves `.values()`
  // and `.set()` against the table's known keys, and a key computed at runtime -
  // `[columnName(column)]: 1` - is silently DROPPED rather than rejected: the
  // statement came out as `values (..., default, default, default)` with no SET
  // clause for the counter at all. Passing `sql` to `.set()` is no better; the
  // builder discards it and emits `do update set` followed immediately by
  // RETURNING, which is a syntax error. Every outcome counter therefore stayed at
  // zero against real Postgres while all 31 unit tests passed, because they assert
  // against a stub database that never renders SQL.
  //
  // Written out longhand, the column name is a validated enum and the statement is
  // the one the comment at the top of this file claims. It is still one statement,
  // so the atomicity guarantee is unchanged.
  const name = columnName(column);
  const result: any = await db.execute(sql`
    insert into abuse_ip_windows (ip, window_start, ${sql.raw(name)}, updated_at)
    values (${ip}, ${windowStart}, 1, now())
    on conflict (ip, window_start) do update
      set ${sql.raw(name)} = abuse_ip_windows.${sql.raw(name)} + 1,
          updated_at = now()
    returning posts, validation_failures, turnstile_failures, successful_progressions
  `);
  return result?.rows?.[0];
}

// drizzle's `.set()` is a plain object at the type level, so the column is chosen
// by name here. Centralised so the four callers cannot drift apart, and typed as a
// closed union because it is interpolated into SQL with sql.raw().
function columnName(
  column: typeof abuseIpWindows.posts | typeof abuseIpWindows.validationFailures
  | typeof abuseIpWindows.turnstileFailures | typeof abuseIpWindows.successfulProgressions,
): "posts" | "validation_failures" | "turnstile_failures" | "successful_progressions" {
  return column.name as "posts" | "validation_failures" | "turnstile_failures" | "successful_progressions";
}

export const recordValidationFailure = (db: Db, ip: string, w: number) =>
  bump(db, ip, w, abuseIpWindows.validationFailures);
export const recordTurnstileFailure = (db: Db, ip: string, w: number) =>
  bump(db, ip, w, abuseIpWindows.turnstileFailures);
export const recordSuccessfulProgression = (db: Db, ip: string, w: number) =>
  bump(db, ip, w, abuseIpWindows.successfulProgressions);

/**
 * Read ESTABLISHED evidence for one IP - i.e. what was true BEFORE the current
 * request is recorded.
 *
 * The order of the two reads is not arbitrary and must not be swapped. The window
 * counters are read first, because that read defines "before"; the distinct-phone
 * count is taken after so that a phone counted moments ago by an earlier request
 * in the same window is included. Either way the caller's decision is made on a
 * snapshot taken before this request was written.
 */
export async function readEstablished(
  db: Db,
  ip: string,
  windowStart: number,
): Promise<EstablishedEvidence> {
  const [row] = await db
    .select()
    .from(abuseIpWindows)
    .where(and(eq(abuseIpWindows.ip, ip), eq(abuseIpWindows.windowStart, windowStart)))
    .limit(1);

  const distinct = await db
    .select({ n: sql<number>`count(*)` })
    .from(abuseIpPhones)
    .where(and(eq(abuseIpPhones.ip, ip), eq(abuseIpPhones.windowStart, windowStart)));

  const counts: WindowCounts | undefined = row;
  return {
    windowStart,
    posts: counts?.posts ?? 0,
    distinctPhones: Number(distinct[0]?.n ?? 0),
    validationFailures: counts?.validationFailures ?? 0,
    turnstileFailures: counts?.turnstileFailures ?? 0,
    successfulProgressions: counts?.successfulProgressions ?? 0,
  };
}

/**
 * Note that one IP used one phone in this window.
 *
 * `onConflictDoNothing` because counting DISTINCT phones is the entire point: the
 * second request from the same person must not make them look like a second
 * customer, which is the difference between a shared NAT and a flood.
 *
 * A null phoneNorm is skipped entirely. We could not identify the person, so we
 * must not contribute evidence about how many distinct people there are -
 * uncertainty never manufactures suspicion.
 */
export async function notePhone(db: Db, ip: string, windowStart: number, phoneNorm: string | null) {
  if (!phoneNorm) return;
  await db
    .insert(abuseIpPhones)
    .values({ ip, windowStart, phoneNorm })
    .onConflictDoNothing();
}

/** Append one observation. Never throws into the caller. */
export async function recordObservation(
  db: Db,
  entry: {
    ip: string;
    phoneNorm: string | null;
    outcome: string;
    wouldRestrict: boolean;
    reason: string | null;
    orderId?: number | null;
  },
) {
  const [row] = await db.insert(abuseObservations).values({
    ip: entry.ip,
    phoneNorm: entry.phoneNorm,
    outcome: entry.outcome,
    wouldRestrict: entry.wouldRestrict,
    reason: entry.reason,
    orderId: entry.orderId ?? null,
  }).returning();
  return row;
}

/** Newest observations first, for the admin shadow report. */
export async function listRecent(db: Db, limit = 50, onlyWouldRestrict = false) {
  const where = onlyWouldRestrict ? eq(abuseObservations.wouldRestrict, true) : undefined;
  return db
    .select()
    .from(abuseObservations)
    .where(where)
    .orderBy(desc(abuseObservations.createdAt))
    .limit(limit);
}

/**
 * Delete windows older than the cutoff.
 *
 * The existing cron-job.org schedule calls this. Retention only ever removes
 * observation rows, never orders and never an admin's recorded reason: the tables
 * here are counters, and a counter whose window has expired cannot influence any
 * decision.
 */
export async function pruneExpiredWindows(db: Db, olderThanSeconds: number) {
  const cutoffSeconds = Math.floor(Date.now() / 1000) - olderThanSeconds;
  await db.delete(abuseIpWindows).where(lt(abuseIpWindows.windowStart, cutoffSeconds));
  await db.delete(abuseIpPhones).where(lt(abuseIpPhones.windowStart, cutoffSeconds));
  // Observations are the evidence behind any future enforcement decision, so they
  // are NOT pruned here. Their retention is a separate, longer policy.
}