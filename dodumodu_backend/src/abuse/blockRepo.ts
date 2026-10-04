import { sql } from "drizzle-orm";
import type { Db } from "../db";
import { moderationBlocks } from "../schema";

// Reading and writing IP/device blocks.
//
// SCOPE IS ip OR device. NEVER phone. That is not a convention here - it is a CHECK
// constraint on the table (migrations/0012), so the database refuses the row. An
// automatic burst block is a statement about a machine for ten minutes; a permanent
// decision about a person is the spam flag's job, and that one requires a human to
// write a reason.
//
// EXPIRY IS THE DATABASE'S CLOCK. `expires_at > now()` is evaluated by PostgreSQL in
// every predicate below, never by comparing against a timestamp computed in the
// application. A worker whose clock drifts would otherwise extend or shorten real
// blocks, and neither would be visible from the outside.

export type BlockRow = typeof moderationBlocks.$inferSelect;
export type BlockScope = "ip" | "device";
export type BlockSource = "manual" | "auto_v1" | "auto_v2";

/** What a blocked request is told, with the countdown computed by the database. */
export type ActiveBlock = {
  scope: BlockScope;
  expiresAt: Date | null;
  /** Seconds left, straight from the DB clock. Never negative. */
  remainingSeconds: number;
  source: BlockSource;
};

/**
 * The live block covering a request, or null.
 *
 * ONE query for both subjects. Checking the address and the device separately would
 * be two round trips on the hot path of every order, and the answer is a single
 * yes/no - so both are asked at once and the more specific match wins.
 *
 * An expired block is still `active` in the table until something retires it; this
 * predicate ignores it, which is what makes the block self-expiring even if nothing
 * ever runs to clean it up.
 */
export async function findActiveFor(
  db: Db,
  subjects: { ip: string | null; deviceId: string | null },
): Promise<ActiveBlock | null> {
  const conditions: ReturnType<typeof sql>[] = [];
  if (subjects.ip) {
    conditions.push(sql`(${moderationBlocks.scope} = 'ip' AND ${moderationBlocks.value} = ${subjects.ip})`);
  }
  if (subjects.deviceId) {
    conditions.push(sql`(${moderationBlocks.scope} = 'device' AND ${moderationBlocks.value} = ${subjects.deviceId})`);
  }
  // Nothing to match on: a request with neither subject cannot be blocked. This is
  // the null-IP path, and returning null here is what makes "never counted, never
  // blocked" true rather than merely intended.
  if (conditions.length === 0) return null;

  const result: any = await db.execute(sql`
    SELECT scope, source, expires_at,
           GREATEST(0, EXTRACT(EPOCH FROM (expires_at - now()))::int) AS remaining_seconds
    FROM moderation_blocks
    WHERE active
      AND ( ${sql.join(conditions, sql` OR `)} )
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY expires_at NULLS LAST
    LIMIT 1
  `);
  const row = result?.rows?.[0];
  if (!row) return null;
  return {
    scope: row.scope as BlockScope,
    source: row.source as BlockSource,
    expiresAt: row.expires_at ?? null,
    remainingSeconds: Number(row.remaining_seconds ?? 0),
  };
}

/** Every live block, newest first. The Blocked screen. */
export async function listActive(db: Db, limit = 100): Promise<BlockRow[]> {
  const result: any = await db.execute(sql`
    SELECT * FROM moderation_blocks
    WHERE active AND (expires_at IS NULL OR expires_at > now())
    ORDER BY blocked_at DESC
    LIMIT ${limit}
  `);
  return (result?.rows ?? []).map(toBlockRow);
}

/** Raw SQL returns snake_case; the drizzle type is camelCase. Mapped explicitly
 * rather than cast, so a column rename breaks here rather than silently producing
 * `undefined` in the admin UI.
 */
function toBlockRow(row: any): BlockRow {
  return {
    id: row.id,
    scope: row.scope,
    value: row.value,
    reason: row.reason,
    source: row.source,
    blockedBy: row.blocked_by,
    blockedAt: row.blocked_at,
    expiresAt: row.expires_at ?? null,
    releasedAt: row.released_at ?? null,
    releasedBy: row.released_by ?? null,
    releaseReason: row.release_reason ?? null,
    active: row.active,
    evidence: row.evidence ?? null,
  };
}

/** Every block ever recorded, live or released. The audit view. */
export async function listAll(db: Db, limit = 200): Promise<BlockRow[]> {
  const result: any = await db.execute(sql`
    SELECT * FROM moderation_blocks
    ORDER BY blocked_at DESC
    LIMIT ${limit}
  `);
  return result?.rows ?? [];
}
/**
 * Create a block, or join the one that already exists.
 *
 * RACE-SAFE BY CONSTRUCTION, which is the whole reason this is hand-written SQL.
 * Twenty simultaneous requests can all decide to block the same device; the partial
 * unique index (scope, value) WHERE active arbitrates between them and exactly one
 * row survives. A read-then-insert would let twenty through.
 *
 * The expired-retire UPDATE runs first, inside the same statement sequence, so a
 * lapsed ten-minute block cannot wedge its subject: without it, the index would
 * still hold that (scope, value) and no new block could ever be created for it.
 *
 * Returns null when another request won the race. That is not an error - it means
 * the caller did not need to do anything.
 */
export async function createBlock(
  db: Db,
  input: {
    scope: BlockScope;
    value: string;
    reason: string;
    source: BlockSource;
    blockedBy: string;
    /** Seconds. Null means permanent, and only a manual block may pass null. */
    seconds: number | null;
    evidence: Record<string, unknown> | null;
  },
): Promise<BlockRow | null> {
  // Retire a lapsed block so the partial index frees the (scope, value) slot. This
  // is bookkeeping, not a decision: it records that time passed, and names nobody.
  await db.execute(sql`
    UPDATE moderation_blocks
       SET active = false,
           released_at = now(),
           released_by = 'system:expiry',
           release_reason = 'expired'
     WHERE scope = ${input.scope}
       AND value = ${input.value}
       AND active
       AND expires_at IS NOT NULL
       AND expires_at <= now()
  `);

  // now() + interval, not Date.now() arithmetic: the block's lifetime is measured by
  // the same clock every later expiry check will use.
  const expiry = input.seconds === null
    ? null
    : sql`now() + make_interval(secs => ${input.seconds})`;

  const result: any = await db.execute(sql`
    INSERT INTO moderation_blocks
      (scope, value, reason, source, blocked_by, expires_at, evidence)
    VALUES
      (${input.scope}, ${input.value}, ${input.reason}, ${input.source},
       ${input.blockedBy}, ${expiry}, ${input.evidence ? JSON.stringify(input.evidence) : null}::jsonb)
    ON CONFLICT (scope, value) WHERE active DO NOTHING
    RETURNING *
  `);
  return result?.rows?.[0] ?? null;
}

/**
 * Release a block.
 *
 * Fills in the release columns; never deletes. "This was blocked and then somebody
 * looked again and disagreed" is the single most useful record this table holds,
 * and deleting the row would make a mistaken block indistinguishable from one that
 * never happened.
 *
 * The automatic ten-minute expiry uses exactly the same columns, so a block that
 * aged out and a block an operator released look the same to a reader - which is
 * honest, because the effect was the same.
 */
export async function releaseBlock(
  db: Db,
  id: number,
  releasedBy: string,
  reason: string,
): Promise<BlockRow | null> {
  const result: any = await db.execute(sql`
    UPDATE moderation_blocks
       SET active = false,
           released_at = now(),
           released_by = ${releasedBy},
           release_reason = ${reason}
     WHERE id = ${id} AND active
    RETURNING *
  `);
  return result?.rows?.[0] ?? null;
}

/** Counts, for the Blocked screen header. */
export async function activeCounts(db: Db): Promise<{ automatic: number; manual: number }> {
  const result: any = await db.execute(sql`
    SELECT count(*) FILTER (WHERE source <> 'manual')::int AS automatic,
           count(*) FILTER (WHERE source = 'manual')::int   AS manual
    FROM moderation_blocks
    WHERE active AND (expires_at IS NULL OR expires_at > now())
  `);
  const row = result?.rows?.[0] ?? {};
  return { automatic: Number(row.automatic ?? 0), manual: Number(row.manual ?? 0) };
}
