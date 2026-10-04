import type { DiscountTierRow } from "../data/discountTiersRepo";

export type PriceBreakdown = {
  unitPrice: number;
  quantity: number;
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  amount: number;
};

type Tier = Pick<DiscountTierRow, "minQuantity" | "discountPercent" | "active">;

export const discountService = {
  /**
   * Among ACTIVE tiers whose minQuantity <= quantity, use the one with the
   * highest minQuantity. This naturally makes a tier cover a range (e.g. a
   * minQuantity=3 tier covers both 3 and 4 units) because the next tier only
   * takes over once quantity reaches its own minQuantity.
   */
  resolveDiscountPercent(quantity: number, tiers: Tier[]): number {
    const applicable = tiers
      .filter((t) => t.active && t.minQuantity <= quantity)
      .sort((a, b) => b.minQuantity - a.minQuantity);
    return applicable[0]?.discountPercent ?? 0;
  },

  /**
   * §8.8 — this exact formula and rounding is mirrored in pricing.js on the
   * frontend. If the two ever disagree for the same inputs, that's a bug to
   * fix in the formula, not a discrepancy to reconcile around.
   */
  computePriceBreakdown(unitPrice: number, quantity: number, tiers: Tier[]): PriceBreakdown {
    const subtotal = unitPrice * quantity;
    const discountPercent = this.resolveDiscountPercent(quantity, tiers);
    const discountAmount = Math.round((subtotal * discountPercent) / 100);
    const amount = subtotal - discountAmount;
    return { unitPrice, quantity, subtotal, discountPercent, discountAmount, amount };
  },
};
