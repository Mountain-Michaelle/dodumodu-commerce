import { eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { paymentRules } from "../schema";

export type PaymentRulesRow = typeof paymentRules.$inferSelect;
export type PaymentRules = Pick<PaymentRulesRow, "codStates" | "codBulkThreshold">;

/**
 * The safe answer when the singleton row is missing (a fresh database where
 * 0002 ran but the seed didn't, or a hand-purged table): no state gets COD and
 * nothing is eligible. Failing the other way — wide open COD — is the one
 * failure this feature exists to prevent.
 */
export const CLOSED_PAYMENT_RULES: PaymentRules = { codStates: [], codBulkThreshold: 0 };

export const paymentRulesRepo = {
  /**
   * Reads are on the hot path of every order, so this selects only the two
   * columns needed rather than the whole row. A missing row is handled, but a
   * dead/absent table is deliberately NOT swallowed — order creation already
   * fails in that case (it reads discount_tiers in the same request).
   */
  async get(db: Db): Promise<PaymentRules> {
    const [row] = await db
      .select({
        codStates: paymentRules.codStates,
        codBulkThreshold: paymentRules.codBulkThreshold,
      })
      .from(paymentRules)
      .where(eq(paymentRules.id, 1));

    if (!row) return CLOSED_PAYMENT_RULES;
    return { codStates: row.codStates ?? [], codBulkThreshold: row.codBulkThreshold };
  },

  async listAll(db: Db): Promise<PaymentRulesRow[]> {
    return db.select().from(paymentRules);
  },

  /** Admin write: there is only ever one row, so this is an upsert on id = 1. */
  async update(db: Db, input: PaymentRules): Promise<PaymentRulesRow> {
    const [row] = await db
      .insert(paymentRules)
      .values({ id: 1, codStates: input.codStates, codBulkThreshold: input.codBulkThreshold })
      .onConflictDoUpdate({
        target: paymentRules.id,
        set: {
          codStates: input.codStates,
          codBulkThreshold: input.codBulkThreshold,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row;
  },
};
