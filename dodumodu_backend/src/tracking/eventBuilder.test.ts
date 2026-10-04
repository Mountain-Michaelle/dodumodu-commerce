import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPurchaseEvent, isPrepaid, type Attribution, type PurchasableOrder } from "./eventBuilder";
import { hashPhone } from "./hashing";

/* Only real buyers, counted once, for the right amount.
 *
 * Every test here is about a way this event could be WRONG rather than a way it
 * could be missing, because the two failure modes are not equally dangerous.
 * A missing event is a small loss of learning. A purchase fired for an order
 * nobody paid for trains the ad algorithm to find people who refuse parcels,
 * costs real money on the next campaign, and cannot be taken back once the
 * platform has it. */

const attribution: Attribution = {
  pageUrl: "https://shop.example/products/glow-serum/",
  clientIp: "203.0.113.9",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
  clickIds: { fbclid: "abc123", ttclid: "tt-999" },
  cookies: { fbp: "fb.1.155", ttp: "tt-1", _fbc: "fb.abc123.fb.1.155" },
};

const prepaid = (over: Partial<PurchasableOrder> = {}): PurchasableOrder => ({
  id: 1,
  reference: "DM-2026-0001",
  amount: 4_500_00, // kobo
  currency: "NGN",
  paymentMethod: "pay_now",
  state: "Lagos",
  productId: 7,
  quantity: 2,
  phone: "+2348031234567",
  createdAt: new Date("2026-02-01T10:00:00Z"),
  ...over,
});

const cod = (over: Partial<PurchasableOrder> = {}) => prepaid({ paymentMethod: "cod", ...over });

/* ---- the gate: no money, no event ---- */

test("a pay-on-delivery order with no recorded collection produces NO purchase", () => {
  // The single most important test in this file. An unpaid parcel is not a sale,
  // and reporting it as one is unrecoverable once the platform has it.
  assert.equal(buildPurchaseEvent(cod(), attribution), null);
  assert.equal(buildPurchaseEvent(cod(), attribution, { collection: null }), null);
});

test("a collection of zero is not a purchase", () => {
  // Guards the "operator recorded nothing" and "amount defaulted to 0" paths.
  const event = buildPurchaseEvent(cod(), attribution, {
    collection: { collectedAmount: 0, deliveredAt: new Date(), items: [] },
  });
  assert.equal(event, null);
});

test("the payment mode is read from the order, never re-derived", () => {
  // A COD order in Lagos with a quantity under the bulk threshold still needs a
  // collection. If mode were re-derived from state/quantity here, this would pass
  // a purchase for an unpaid order - the exact duplicate-rule bug to avoid.
  assert.equal(isPrepaid(cod({ state: "Lagos", quantity: 1 })), false);
  assert.equal(buildPurchaseEvent(cod({ state: "Lagos", quantity: 1 }), attribution), null);
});

/* ---- value and currency ---- */

test("a prepaid purchase carries the charged amount in minor units", () => {
  const event = buildPurchaseEvent(prepaid(), attribution, { confirmedAt: new Date("2026-02-01T10:05:00Z") })!;
  assert.equal(event.value, 4_500_00);
  assert.equal(event.currency, "NGN");
  // Kobo, not naira: platforms sum this field, so sending naira under-reports by
  // 100x and is invisible in the API response.
  assert.equal(event.value, 450000);
});

test("a collection value is what was COLLECTED, not what was ordered", () => {
  // The customer took one item instead of two at the door. Reporting the order
  // total would overstate revenue by exactly the amount we never received.
  const event = buildPurchaseEvent(cod({ amount: 4_500_00 }), attribution, {
    collection: {
      collectedAmount: 2_250_00,
      deliveredAt: new Date("2026-02-04T09:00:00Z"),
      items: [{ productId: 7, quantity: 1 }],
    },
  })!;
  assert.equal(event.value, 2_250_00);
  assert.equal(event.content.length, 1);
  assert.equal(event.content[0].quantity, 1);
});

/* ---- event time: confirmation, never send ---- */

test("a prepaid purchase's event time is the confirmation, not the send", () => {
  // The real hazard: the event is built now, but it may not reach the platform
  // until ctx.waitUntil runs, or until a cron retry hours later. Sending the
  // send-time would shift every conversion forward and corrupt attribution.
  const confirmed = new Date("2026-02-01T10:05:00Z");
  const sentHoursLater = new Date("2026-02-01T18:40:00Z");
  const event = buildPurchaseEvent(prepaid(), attribution, { confirmedAt: confirmed })!;
  assert.equal(event.eventTime, confirmed.toISOString());
  assert.notEqual(event.eventTime, sentHoursLater.toISOString());
});

test("a collection's event time is when the cash was taken", () => {
  // A pay-on-delivery confirmation is legitimately days after the ad click, and
  // the platforms measure attribution from the click. The COLLECTION overrides
  // confirmedAt entirely, so no caller mistake can move it.
  const collected = new Date("2026-02-07T16:30:00Z");
  const event = buildPurchaseEvent(cod(), attribution, {
    collection: { collectedAmount: 450000, deliveredAt: collected, items: [{ productId: 7, quantity: 1 }] },
    confirmedAt: new Date("2026-02-07T16:30:01Z"),
  })!;
  assert.equal(event.eventTime, collected.toISOString());
});

/* ---- dedup ---- */

test("the event id is the order reference, so a replay reuses it", () => {
  // Two webhook deliveries of the same order must produce byte-identical ids, or
  // the platform sees two purchases. This is the dedup anchor.
  const a = buildPurchaseEvent(prepaid(), attribution, { confirmedAt: new Date("2026-02-01T10:05:00Z") })!;
  const b = buildPurchaseEvent(prepaid(), attribution, { confirmedAt: new Date("2026-02-01T10:06:00Z") })!;
  assert.equal(a.eventId, b.eventId);
  assert.equal(a.eventId, "DM-2026-0001");
});

/* ---- customer data ---- */

test("the phone is hashed and normalised, never passed raw", () => {
  const event = buildPurchaseEvent(prepaid({ phone: "0803 123 4567" }), attribution)!;
  assert.equal(event.user.phoneHash, hashPhone("+2348031234567"));
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes("08031234567"), "raw phone must not appear anywhere in the event");
  assert.ok(!serialized.includes("0803 123 4567"));
});

test("click ids and cookies pass through unhashed, as the platforms specify", () => {
  const event = buildPurchaseEvent(prepaid(), attribution)!;
  assert.equal(event.clickIds.fbclid, "abc123");
  assert.equal(event.clickIds.ttclid, "tt-999");
  assert.equal(event.cookies.fbp, "fb.1.155");
  // Unhashed, because these are platform identifiers, not customer data.
  assert.equal(event.cookies.ttp, "tt-1");
});

test("IP and user agent pass through unhashed, as the platforms specify", () => {
  const event = buildPurchaseEvent(prepaid(), attribution)!;
  assert.equal(event.clientIp, "203.0.113.9");
  assert.match(event.userAgent!, /iPhone/);
});

/* ---- content ---- */

test("content ids are strings, because both platforms treat them that way", () => {
  const event = buildPurchaseEvent(prepaid(), attribution)!;
  assert.deepEqual(event.content, [{ id: "7", quantity: 2 }]);
  assert.equal(typeof event.content[0].id, "string");
});

test("an empty item list on a collection falls back to the ordered items", () => {
  // Defensive: an operator who cleared every line is rejected upstream by the
  // modal, so this should be unreachable - but a purchase with zero content is
  // worse than a fallback, and the fallback is still the truth for a plain order.
  const event = buildPurchaseEvent(cod(), attribution, {
    collection: { collectedAmount: 450000, deliveredAt: new Date(), items: [] },
  })!;
  assert.deepEqual(event.content, [{ id: "7", quantity: 2 }]);
});