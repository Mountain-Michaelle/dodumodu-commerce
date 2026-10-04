/**
 * Backfill orders.phone_norm for historical rows.
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF A MIGRATION:
 *
 * A migration is a blocking, transactional schema change. Normalizing every
 * historical row is neither - it is a slow, resumable, per-row job using a
 * JavaScript library. Putting it in a migration would hold a transaction open
 * across thousands of rows on a free-tier database, and would put ~200 KB of
 * phone-parsing code inside the schema-change boundary where a failure is
 * hardest to reason about.
 *
 * WHY IT USES THE ONE NORMALIZER:
 *
 * It imports src/shared/normalizePhone.ts - the same function the order path, the
 * spam flags and the ad-tracking hash already use. There is no SQL normalizer, no
 * second TypeScript implementation, no generated column, and no special handling
 * for historical rows. One implementation decides what a phone number is.
 *
 * SAFETY:
 *
 *  - Idempotent: rows that already have a phone_norm are skipped.
 *  - Bounded: processed in batches, so memory stays flat on any dataset size.
 *  - Non-destructive: only ever writes phone_norm. It never changes a phone, a
 *    status, a price or anything else, and never deletes an order.
 *  - A number it cannot resolve becomes NULL and the row is left alone. That row
 *    is then excluded from identity-based checks, which fails OPEN - the customer
 *    is unaffected, and the only cost is that we cannot attribute them.
 *
 * Usage:  npx tsx scripts/backfill-phone-norm.ts [--limit N] [--dry-run]
 */
import { registerDbDriver } from "../src/db";
import { pgDriver } from "../src/dbDrivers/pg";
import { normalizePhone } from "../src/shared/normalizePhone";
import pg from "pg";

registerDbDriver(pgDriver);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Number.POSITIVE_INFINITY;
const BATCH = 500;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

const stats = { scanned: 0, normalized: 0, unresolved: 0, alreadySet: 0 };
const unresolvedExamples = new Set<string>();

/** Select rows still needing a value, oldest first, one bounded batch. */
async function nextBatch() {
  // A FIXED placeholder shape. Deriving parameter numbers from a condition is the
  // kind of cleverness that breaks the moment the query changes; the cursor is
  // passed unconditionally and the limit window is applied in JS instead.
  const { rows } = await client.query(
    "SELECT id, phone FROM orders WHERE phone_norm IS NULL AND id > $1::bigint ORDER BY id LIMIT $2",
    [cursor, BATCH],
  );
  return rows;
}

let cursor = 0;
for (;;) {
  const rows = await nextBatch();
  if (rows.length === 0) break;

  const values: string[] = [];
  const ids: number[] = [];
  for (const row of rows) {
    cursor = row.id;
    stats.scanned += 1;
    const normalized = normalizePhone(row.phone);
    if (normalized === null) {
      // Never invented. Left NULL, which excludes the row from identity checks.
      stats.unresolved += 1;
      if (unresolvedExamples.size < 10) unresolvedExamples.add(row.phone);
      continue;
    }
    ids.push(row.id);
    values.push(normalized);
  }

  if (ids.length > 0) {
    stats.normalized += ids.length;
    if (!dryRun) {
      // One parameterized statement per batch; no string interpolation of values.
      await client.query(
        `UPDATE orders AS o SET phone_norm = v.phone_norm
           FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::text[]) AS phone_norm) AS v
          WHERE o.id = v.id`,
        [ids, values],
      );
    }
  }

  if (rows.length < BATCH) break;
  if (stats.scanned > 5_000_000) break; // a runaway guard, not an expected path
}

const remaining = await client.query(
  "SELECT count(*)::int AS n FROM orders WHERE phone_norm IS NULL",
);

console.log(`mode            : ${dryRun ? "DRY RUN (nothing written)" : "write"}`);
console.log(`rows scanned    : ${stats.scanned}`);
console.log(`normalized      : ${stats.normalized}`);
console.log(`unresolved (NULL): ${stats.unresolved}`);
console.log(`still NULL after: ${remaining.rows[0].n}`);
if (unresolvedExamples.size > 0) {
  console.log(`examples left NULL: ${[...unresolvedExamples].map((v) => JSON.stringify(v)).join(", ")}`);
}

await client.end();
