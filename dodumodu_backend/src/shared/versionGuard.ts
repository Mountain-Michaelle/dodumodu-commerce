import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

// The optimistic-concurrency guard for `timestamp without time zone` version
// columns: the caller's copy of `updatedAt` goes in the WHERE, so a row that
// moved since it was read matches nothing and the caller is told, instead of
// quietly overwriting.
//
// The bound is a naive wall-clock STRING, not a Date parameter, and that is
// load-bearing rather than a style choice:
//
//   - drizzle reads the naive column as UTC (`new Date(value + "+0000")`), so
//     the millisecond the browser is shown is exactly the digits stored in the
//     table, and `toISOString()` on the value that comes back is the identity
//     on those digits;
//   - but a Date bound as a query parameter is serialised by node-postgres in
//     *process-local* time, and Postgres drops the offset when the value lands
//     on the naive column. On any machine whose local time is not UTC the bound
//     then sits hours away from what is stored, the predicate never matches,
//     and every guarded admin write reports a spurious conflict (the
//     "changed while you were looking at it" 409 on every save).
//
// The one-millisecond bucket (rather than equality) exists because the column
// keeps microseconds while a Date keeps milliseconds: a stored `.664514` and
// the `.664` shown to the browser are the same version.
export function updatedAtBucketCondition(column: SQLWrapper, expectedUpdatedAt: Date): SQL {
  const { from, to } = updatedAtBucketBounds(expectedUpdatedAt);
  return sql`${column} >= ${from} AND ${column} < ${to}`;
}

/**
 * The half-open [from, to) millisecond bucket of `expectedUpdatedAt`, in the
 * naive shape Postgres stores: '2026-10-07 21:06:32.589' … '2026-10-07 21:06:32.590'.
 * Sub-millisecond remainders round-trip into it because Date parsing truncates
 * the microsecond fraction, which keeps stored values inside their own bucket.
 */
export function updatedAtBucketBounds(expectedUpdatedAt: Date): { from: string; to: string } {
  return {
    from: naiveUtc(expectedUpdatedAt),
    to: naiveUtc(new Date(expectedUpdatedAt.getTime() + 1)),
  };
}

/** A Date in the shape a naive timestamp column stores: '2026-10-07 21:06:32.589'. */
export function naiveUtc(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}
