import { and, eq, isNull, desc, sql } from "drizzle-orm";
import type { Db } from "../db";
import { spamFlags } from "../schema";

// Reading and writing manual spam flags.
//
// Everything here is keyed on `phone_norm`, the canonical identity from the ONE
// shared normalizer. There is deliberately no lookup by raw phone text anywhere in
// this file: "08012345678" and "+2348012345678" are the same customer, and a flag
// stored against one spelling must apply to every other spelling.

export type SpamFlagRow = typeof spamFlags.$inferSelect;

/** The active flag for a canonical phone, or null. The hot path on every order. */
export async function findActive(db: Db, phoneNorm: string): Promise<SpamFlagRow | null> {
  const [row] = await db
    .select()
    .from(spamFlags)
    .where(and(eq(spamFlags.phoneNorm, phoneNorm), isNull(spamFlags.revertedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Flag a phone.
 *
 * The partial unique index (phone_norm) WHERE reverted_at IS NULL is the real
 * guarantee that one phone cannot carry two active flags; a violation surfaces as
 * a unique error the service turns into a conflict. This function deliberately
 * does NOT pre-check, because a pre-check would race - two simultaneous clicks
 * could both see "no active flag" and both insert.
 */
export async function insert(db: Db, input: {
  phoneNorm: string;
  sourceOrderId: number | null;
  reason: string;
  flaggedBy: string;
}) {
  const [row] = await db.insert(spamFlags).values({
    phoneNorm: input.phoneNorm,
    sourceOrderId: input.sourceOrderId,
    reason: input.reason,
    flaggedBy: input.flaggedBy,
  }).returning();
  return row;
}

/**
 * Revert a flag by filling in the revert columns. Never a delete.
 *
 * Guarded on `reverted_at IS NULL` so a double-click or a retry cannot overwrite
 * who reverted it or when, and so the history records the FIRST decision - the one
 * that actually took effect.
 */
export async function revert(
  db: Db,
  id: number,
  revertedBy: string,
  revertReason: string,
): Promise<SpamFlagRow | null> {
  const rows = await db
    .update(spamFlags)
    .set({ revertedAt: new Date(), revertedBy, revertReason })
    .where(and(eq(spamFlags.id, id), isNull(spamFlags.revertedAt)))
    .returning();
  return rows[0] ?? null;
}

/** Active flags for the admin list. */
export async function listActive(db: Db, limit = 100) {
  return db.select().from(spamFlags)
    .where(isNull(spamFlags.revertedAt))
    .orderBy(desc(spamFlags.flaggedAt))
    .limit(limit);
}

/** Every flag including reverted ones - the audit view. */
export async function listAll(db: Db, limit = 200) {
  return db.select().from(spamFlags).orderBy(desc(spamFlags.flaggedAt)).limit(limit);
}

/**
 * Which of these canonical phones currently carry an active flag.
 *
 * Used by the orders list to tint rows. Batched into ONE query for the whole page
 * rather than per-row, because a per-row lookup on every page of the admin list is
 * the kind of thing that makes a console feel broken.
 */
export async function activePhoneSet(db: Db, phoneNorms: string[]): Promise<Set<string>> {
  if (phoneNorms.length === 0) return new Set();
  const rows = await db
    .select({ phoneNorm: spamFlags.phoneNorm })
    .from(spamFlags)
    .where(and(isNull(spamFlags.revertedAt), sql`${spamFlags.phoneNorm} IN ${phoneNorms}`));
  return new Set(rows.map((r) => r.phoneNorm));
}

/** Every currently active canonical phone, for bounded report aggregation. */
export async function activePhoneNorms(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ phoneNorm: spamFlags.phoneNorm })
    .from(spamFlags)
    .where(isNull(spamFlags.revertedAt));
  return new Set(rows.map((row) => row.phoneNorm));
}

/**
 * Suspects: phones with several orders and ZERO legitimate progression.
 *
 * A SUGGESTION LIST for a human, never an automatic flag. It surfaces the "keeps
 * ordering but never buys" case; deciding whether someone is a fraudster is a
 * judgement a person makes with context, not something a query concludes.
 *
 * It groups on the STORED `phone_norm`, so there is no normalization in this query
 * at all - the identity was resolved once, by the shared normalizer, when the
 * order was written. A SQL normalizer here would be a second implementation able
 * to disagree with it.
 *
 * `paid`, `confirmed_cod` and `delivered` all count as progression, so any real
 * success removes the phone. confirmed_cod matters most: under a cash-on-delivery
 * business it is the NORMAL state of every good order, and treating it as failure
 * would put every legitimate cash-on-delivery customer on this list.
 *
 * The NOT IN subquery means the list can only contain phones with NO successful
 * order at all - a much stronger and more honest statement than "a low success
 * rate".
 */
export async function listSuspects(
  db: Db,
  opts: { minOrders: number; windowDays: number; limit?: number; offset?: number; phonePattern?: string | null },
): Promise<{ phoneNorm: string; orders: number; oldest: Date; newest: Date }[]> {
  const since = new Date(Date.now() - opts.windowDays * 86_400_000);
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 100)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const pattern = opts.phonePattern ?? null;
  const result = await db.execute(sql`
    SELECT phone_norm,
           count(*)::int AS orders,
           min(created_at) AS oldest,
           max(created_at) AS newest
    FROM orders
    WHERE phone_norm IS NOT NULL
      AND created_at >= ${since}
      AND status NOT IN ('paid', 'confirmed_cod', 'delivered')
      AND phone_norm NOT IN (
        SELECT DISTINCT phone_norm FROM orders
        WHERE phone_norm IS NOT NULL
          AND created_at >= ${since}
          AND status IN ('paid', 'confirmed_cod', 'delivered')
      )
      ${pattern !== null ? sql`AND phone_norm LIKE ${pattern}` : sql``}
    GROUP BY phone_norm
    HAVING count(*) >= ${opts.minOrders}
    ORDER BY count(*) DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  const rows = (result as unknown as { rows: { phone_norm: string; orders: number; oldest: Date; newest: Date }[] }).rows;
  return rows.map((r) => ({
    phoneNorm: r.phone_norm, orders: Number(r.orders), oldest: r.oldest, newest: r.newest,
  }));
}

/** Count of suspect PHONES matching an optional phone pattern.
 *
 * Mirrors the listSuspects GROUP BY/HAVING exactly, then counts the groups — a
 * plain COUNT(*) here would count order rows, not phones, and disagree with the
 * list on every page after the first.
 */
export async function countSuspects(
  db: Db,
  opts: { minOrders: number; windowDays: number; phonePattern: string | null },
): Promise<number> {
  const since = new Date(Date.now() - opts.windowDays * 86_400_000);
  const base = sql`SELECT count(*)::int AS n FROM (
    SELECT phone_norm
    FROM orders
    WHERE phone_norm IS NOT NULL
      AND created_at >= ${since}
      AND status NOT IN ('paid', 'confirmed_cod', 'delivered')
      AND phone_norm NOT IN (
        SELECT DISTINCT phone_norm FROM orders
        WHERE phone_norm IS NOT NULL
          AND created_at >= ${since}
          AND status IN ('paid', 'confirmed_cod', 'delivered')
      )
      ${opts.phonePattern !== null ? sql`AND phone_norm LIKE ${opts.phonePattern}` : sql``}
    GROUP BY phone_norm
    HAVING count(*) >= ${opts.minOrders}
  ) AS suspects
  `;
  const result = await db.execute(base);
  const rows = (result as unknown as { rows: { n: number }[] }).rows;
  return rows.length > 0 ? Number(rows[0].n) : 0;
}

/**
 * Mask a canonical phone for display: keeps the country code and last two digits
 * so an operator can still recognise it, and hides the rest.
 *
 * Masking is for LISTS. A flag's detail view shows the full number, because
 * confirming "is this the same person I think it is" needs it - and that is a
 * deliberate click on one record, not a table of customer phone numbers.
 */
export function maskPhone(phoneNorm: string): string {
  if (!phoneNorm || phoneNorm.length <= 6) return phoneNorm;
  return `${phoneNorm.slice(0, 3)}${"*".repeat(Math.max(0, phoneNorm.length - 5))}${phoneNorm.slice(-2)}`;
}