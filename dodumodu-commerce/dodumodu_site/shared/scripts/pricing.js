// Pure functions only. No DOM, no fetch() — render.js and orchestrate.js use
// these; this file never touches window/document. §8.8: this must produce
// IDENTICAL numbers to discountService.ts for the same inputs — if it ever
// disagrees, that's a bug in one of the two formulas, not something to
// reconcile around client-side.

// The one tier a quantity actually lands in (highest minQuantity that is not
// above the quantity). Returns the whole tier, not just the percent, so the UI
// can show the admin-configured label next to the discounted price.
export function resolveDiscountTier(quantity, tiers) {
  const applicable = tiers
    .filter((t) => t.minQuantity <= quantity)
    .sort((a, b) => b.minQuantity - a.minQuantity);
  return applicable[0] ?? null;
}

export function resolveDiscountPercent(quantity, tiers) {
  return resolveDiscountTier(quantity, tiers)?.discountPercent ?? 0;
}

export function computePriceBreakdown(unitPrice, quantity, tiers) {
  const subtotal = unitPrice * quantity;
  const discountPercent = resolveDiscountPercent(quantity, tiers);
  const discountAmount = Math.round((subtotal * discountPercent) / 100);
  const amount = subtotal - discountAmount;
  return { unitPrice, quantity, subtotal, discountPercent, discountAmount, amount };
}

export function formatNaira(kobo) {
  return `₦${Math.round(kobo / 100).toLocaleString("en-NG")}`;
}

// Built from the tiers themselves (labels come straight from admin config),
// so the percentages shown can never drift from what's actually configured.
export function formatTierSummary(tiers) {
  return tiers
    .filter((t) => t.discountPercent > 0 && t.label)
    .sort((a, b) => a.minQuantity - b.minQuantity)
    .map((t) => t.label)
    .join(" · ");
}

// Returns a short nudge string when increasing quantity by exactly one would
// cross into a better tier, or null otherwise.
export function getNextTierNudge(quantity, tiers) {
  const currentPercent = resolveDiscountPercent(quantity, tiers);
  const nextPercent = resolveDiscountPercent(quantity + 1, tiers);
  if (nextPercent <= currentPercent) return null;

  const nextTier = tiers
    .filter((t) => t.minQuantity === quantity + 1)
    .sort((a, b) => b.discountPercent - a.discountPercent)[0];
  if (!nextTier) return null;

  return `Add 1 more to unlock ${nextTier.discountPercent}% off`;
}
