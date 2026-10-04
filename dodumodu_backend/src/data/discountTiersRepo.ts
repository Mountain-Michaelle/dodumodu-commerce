import { eq, asc, notInArray } from "drizzle-orm";
import type { Db } from "../db";
import { discountTiers } from "../schema";

export type DiscountTierRow = typeof discountTiers.$inferSelect;
type TierInput = Pick<DiscountTierRow, "minQuantity" | "discountPercent" | "label" | "active">;

export const discountTiersRepo = {
  async findActive(db: Db): Promise<DiscountTierRow[]> {
    return db.select().from(discountTiers)
      .where(eq(discountTiers.active, true))
      .orderBy(asc(discountTiers.minQuantity));
  },

  async listAll(db: Db): Promise<DiscountTierRow[]> {
    return db.select().from(discountTiers).orderBy(asc(discountTiers.minQuantity));
  },

  /**
   * §5.12 — replace the whole tier set. Validation (uniqueness, a
   * min_quantity=1 tier present, percent bounds) happens in adminSchema.ts
   * before this is called.
   *
   * NOTE: the Neon HTTP driver (§5.1) doesn't support multi-statement
   * transactions, so this can't be a single atomic swap. It upserts the new
   * rows first (by the min_quantity UNIQUE constraint) and only then deletes
   * whatever's left over — the table is never briefly empty the way a
   * delete-then-insert would leave it, which is the failure mode that
   * actually matters here (an order landing mid-update with zero tiers,
   * silently resolving to 0% instead of the intended discount).
   */
  async replaceAll(db: Db, tiers: TierInput[]): Promise<DiscountTierRow[]> {
    if (tiers.length === 0) {
      await db.delete(discountTiers);
      return [];
    }

    const upserted: DiscountTierRow[] = [];
    for (const tier of tiers) {
      const [row] = await db.insert(discountTiers).values(tier)
        .onConflictDoUpdate({
          target: discountTiers.minQuantity,
          set: {
            discountPercent: tier.discountPercent,
            label: tier.label,
            active: tier.active,
            updatedAt: new Date(),
          },
        })
        .returning();
      upserted.push(row);
    }

    const keepQuantities = tiers.map((t) => t.minQuantity);
    await db.delete(discountTiers).where(notInArray(discountTiers.minQuantity, keepQuantities));

    return upserted;
  },
};

