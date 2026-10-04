// Turning a paid order into a neutral conversion event.
//
// PURE ON PURPOSE. This module imports hashing and nothing from the order
// service, the database or any adapter, so every rule below — which orders may
// produce a purchase at all, what the value is, what the event id is, when the
// event time is — is testable without a database, a network or a Worker.
//
// The rules it enforces, in order of how much damage breaking them would do:
//
//  1. MONEY FIRST. Purchase is only ever built for a payment the business has
//     actually secured: a prepaid order already `paid` by the OPay webhook, or a
//     pay-on-delivery order with a recorded collection. There is deliberately no
//     code path that builds a purchase from an unpaid order, because a purchase
//     the customer never made cannot be unsent — the platform will have trained
//     on it by the time anybody notices.
//
//  2. NO DERIVED PAYMENT MODE. `orders.paymentMethod` is the single source of
//     truth, set at creation by codPolicyService. This module reads it and never
//     re-derives it from state or quantity, because a second rule that can
//     disagree with the first is how a prepaid order gets a delayed purchase
//     event fired days later, long after it already had one.
//
//  3. THE VALUE IS WHAT WAS COLLECTED. For a pay-on-delivery order that is the
//     cash actually taken, which may legitimately differ from the order total if
//     the customer changed the package at the door. Sending the order total would
//     overstate revenue to the algorithm by exactly the amount we did not
//     receive.

import { hashEmail, hashPhone } from "./hashing";
import type { EventName, NeutralEvent } from "./adapters/types";

/** The parts of an order this module reads. Narrow on purpose. */
export type PurchasableOrder = {
  id: number;
  reference: string;
  /** Kobo. What the customer was charged (prepaid) or is expected to pay. */
  amount: number;
  currency: string;
  /** "pay_now" | "cod" — written at order creation, never re-derived here. */
  paymentMethod: string;
  state: string;
  productId: number;
  quantity: number;
  phone: string;
  /** No email is collected on an order today, so this is always undefined. */
  email?: string | null;
  createdAt: Date;
};
/** What a recorded pay-on-delivery collection contributes. */
export type Collection = {
  /** Kobo actually collected. This is the purchase VALUE. */
  collectedAmount: number;
  /** When the money changed hands — the event time, not the send time. */
  deliveredAt: Date;
  /**
   * Items actually handed over. For a plain order this is the order's own
   * product and quantity; for an edited package it is what the operator
   * recorded at the door.
   */
  items: { productId: number; quantity: number }[];
};

export type Attribution = {
  pageUrl: string | null;
  clientIp: string | null;
  userAgent: string | null;
  clickIds: Record<string, string>;
  cookies: Record<string, string>;
};

/**
 * Whether this order is a prepaid one.
/**
 * Whether this order is a prepaid one.
 *
 * This is NOT "may we report a purchase" — that decision belongs to the caller,
 * which knows whether the webhook or a collection has actually happened. This
 * only reports how the order was meant to be paid, so the builder knows where
 * the money is coming from.
 */
export function isPrepaid(order: PurchasableOrder): boolean {
  return order.paymentMethod === "pay_now";
}

/**
 * Build the neutral purchase event, or null when this order must not produce one.
 *
 * Returns null — never a partially-built event — because a caller that receives
 * an object will send it, so "we decided not to count this" has to be
 * unrepresentable in the type rather than a flag somebody forgets to check.
 */
export function buildPurchaseEvent(
  order: PurchasableOrder,
  attribution: Attribution,
  options: {
    /** Present for a pay-on-delivery order; absent for prepaid. */
    collection?: Collection | null;
    /**
     * When the conversion was CONFIRMED, for a prepaid order.
     *
     * Named explicitly rather than `now` because the difference is the whole
     * point. The caller captures this the moment the webhook commits the paid
     * status; the event may not actually leave the Worker for some time after
     * that (it waits on ctx.waitUntil, and retries can be minutes or days later).
     * Sending the send-time instead would shift every conversion forward by the
     * delay and quietly corrupt every attribution window the platform computes.
     *
     * Defaults to the current time, which is correct only for a caller that is
     * running inside the confirmation itself.
     */
    confirmedAt?: Date;
  } = {},
): NeutralEvent | null {
  const isCod = order.paymentMethod === "cod";

  let value = order.amount;
  let eventTime = options.confirmedAt ?? new Date();
  let items = [{ productId: order.productId, quantity: order.quantity }];

  if (isCod) {
    // A cash-on-delivery order only becomes a conversion once money has been
    // recorded as collected. No collection means no purchase — this is the rule
    // that stops an undelivered, unpaid parcel from being reported as a sale.
    const collection = options.collection ?? null;
    if (!collection) return null;
    if (collection.collectedAmount <= 0) return null;
    value = collection.collectedAmount;
    // The moment the cash was taken, NOT the moment this function runs. A
    // pay-on-delivery conversion can legitimately be days old by the time it is
    // sent, and the platforms measure attribution from the ad click.
    eventTime = collection.deliveredAt;
    if (collection.items.length > 0) {
      items = collection.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      }));
    }
  }

  return {
    name: "purchase",
    // The public order reference. It is already unique, already stable, and
    // already known to the customer, and it is what makes a replayed webhook
    // produce the same event id rather than a second purchase.
    eventId: order.reference,
    eventTime: eventTime.toISOString(),
    value,
    currency: order.currency || "NGN",
    pageUrl: attribution.pageUrl,
    user: {
      phoneHash: hashPhone(order.phone),
      emailHash: hashEmail(order.email ?? null),
      city: order.state,
      country: "NG",
    },
    clickIds: attribution.clickIds,
    cookies: attribution.cookies,
    clientIp: attribution.clientIp,
    userAgent: attribution.userAgent,
    content: items.map((item) => ({ id: String(item.productId), quantity: item.quantity })),
  };
}

/**
 * The lower-intent events. These are fired by the BROWSER pixel, not from here.
 *
 * Listed in one place so "which events exist" has a single answer rather than
 * being inferred from three different files, and so the mapping to platform names
 * is visibly exhaustive across both halves of the funnel.
 */
export const BROWSER_EVENT_NAMES: EventName[] = ["page_view", "view_content", "initiate_checkout"];