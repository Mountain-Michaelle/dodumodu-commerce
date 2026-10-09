// One place that hides the driver difference for raw SQL.
//
// db.execute(sql`...`) returns rows differently per driver:
//   - node-postgres  -> Promise<{ rows: T[] }>   (a pg QueryResult)
//   - neon-http      -> Promise<T[]>             (the array, directly)
// Every raw .execute() in the existing production code casts to `{ rows: T[] }`
// and reads `.rows`, which is correct for node-postgres but WRONG for neon-http
// (the Worker). This normalizes both into T[] so the service layer is identical
// under either driver (spec §6: "the same queries and repositories run in both
// environments unchanged").
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "../db";

export type Rows<T> = T[];

function toRows<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const maybe = res as { rows?: unknown } | null | undefined;
  if (maybe && Array.isArray(maybe.rows)) return maybe.rows as T[];
  return [];
}

/** Run raw SQL and always get rows as T[]. Params must be passed inside the SQL. */
export async function q<T = Record<string, unknown>>(
  db: Db,
  query: SQL,
): Promise<T[]> {
  const res = await db.execute(query);
  return toRows<T>(res);
}

/** Run raw SQL and return the first row or null. */
export async function q1<T = Record<string, unknown>>(
  db: Db,
  query: SQL,
): Promise<T | null> {
  const rows = await q<T>(db, query);
  return rows.length > 0 ? rows[0] : null;
}

/** Re-export so service files can build queries without importing drizzle twice. */
export { sql };
export type { SQL };
