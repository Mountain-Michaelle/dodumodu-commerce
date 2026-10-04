import type { PaymentRules } from "../data/paymentRulesRepo";
import { isStateInList } from "./nigeriaStates";

/**
 * The two reasons pay-on-delivery can be refused, and the exact wording for
 * each. The message is the API's 400 body AND the frontend's hint text —
 * codRules.js mirrors these strings so the customer is never told two different
 * things. Change one, change the other (test/form-ux.check.mjs asserts the
 * pairing).
 */
export type CodDenialReason = "state" | "bulk";

export type CodDecision =
  | { allowed: true; reason: null; message: null }
  | { allowed: false; reason: CodDenialReason; message: string };

export class CodNotAvailableError extends Error {
  readonly reason: CodDenialReason;

  constructor(message: string, reason: CodDenialReason) {
    super(message);
    this.reason = reason;
  }
}

export function codDenied(reason: CodDenialReason, state: string, rules: PaymentRules): CodDecision {
  const message = reason === "state"
    ? `Pay on delivery isn't available in ${state || "your area"} yet — choose "Pay now" and we'll dispatch today.`
    : codBulkMessage(rules);
  return { allowed: false, reason, message };
}

/**
 * The bulk ceiling reads as "COD covers up to N items": the threshold itself
 * is the first bulk quantity, so N = threshold - 1. A threshold of 5 means
 * quantities 1–4 may use COD and 5+ must pay now; 0/1 means COD is off
 * regardless of quantity (the fail-closed default is 0).
 */
export function codBulkMessage(rules: PaymentRules): string {
  const covered = rules.codBulkThreshold - 1;
  if (covered < 1) return `Pay on delivery isn't available for this quantity — choose "Pay now" to complete your order.`;
  return `Pay on delivery covers up to ${covered} ${covered === 1 ? "item" : "items"} — choose "Pay now" for bulk orders.`;
}

/**
 * Pure decision — no DB, no clock — so it is trivially testable and so the
 * catalog route can reuse the same rules for what it tells the page to render.
 *
 * Order of the two checks matters for the message the customer sees: an
 * out-of-COD-state customer with 12 items is told about the state (the reason
 * they cannot fix by lowering quantity) because that one is never going to
 * change on this device.
 */
export function decideCod(
  state: string,
  quantity: number,
  rules: PaymentRules,
): CodDecision {
  if (!isStateInList(state, rules.codStates)) return codDenied("state", state, rules);
  // `>=`: codBulkThreshold is the FIRST bulk quantity, not the last eligible
  // one — so 5 means "5 or more pays now". This also fails closed: a threshold
  // of 0/1 allows nothing, since quantity >= 1 always.
  if (quantity >= rules.codBulkThreshold) return codDenied("bulk", state, rules);
  return { allowed: true, reason: null, message: null };
}

export const codPolicyService = {
  decideCod,

  /** The human string for the API's `paymentMethod` field error. */
  denialMessage(state: string, quantity: number, rules: PaymentRules): string | null {
    const decision = decideCod(state, quantity, rules);
    return decision.allowed ? null : decision.message;
  },

  /**
   * What the public page-data payload exposes: which states to advertise COD
   * in, and the quantity ceiling. Never any admin-only bookkeeping.
   */
  publicRules(rules: PaymentRules) {
    return { codStates: rules.codStates, codBulkThreshold: rules.codBulkThreshold };
  },
};
