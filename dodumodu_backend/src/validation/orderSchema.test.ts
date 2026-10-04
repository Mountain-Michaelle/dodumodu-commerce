/* The schema is the first thing a submission meets, and the one rule in it is
   counter-intuitive: turnstileToken is allowed to be empty. That is not a hole,
   it is the contract with the storefront — an empty TURNSTILE_SITE_KEY disables
   the widget, so the page posts an empty token, and verifyTurnstile (routes/
   orders.ts) is the only authority on whether that is allowed. A `.min(1)` here
   once made every local submission fail with a 400 nobody could act on. These
   tests pin that agreement, and pin that relaxing the token relaxed nothing else. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderSchema } from "./orderSchema";

const VALID = {
  idempotencyKey: "9f8a1c2e-4b7d-4a1f-9c3e-2d5b6a7c8e9f",
  turnstileToken: "",
  productId: 1,
  quantity: 1,
  customerName: "Test Buyer",
  phone: "08012345678",
  whatsapp: "08012345678",
  address: "12 Test Street, Ikeja",
  state: "Lagos",
  deliveryDate: "tomorrow",
  paymentMethod: "cod",
};

test("the exact body the local build posts is accepted", () => {
  // This is a literal copy of what orchestrate.js sends when no site key is
  // configured: turnstileToken present but empty, every other field valid.
  const parsed = orderSchema.safeParse(VALID);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.flatten().fieldErrors));
  assert.equal(parsed.data.turnstileToken, "");
});

test("an omitted turnstile token is still a valid shape", () => {
  // The field is defaulted rather than required, so a client that leaves it out
  // reaches verifyTurnstile and is judged there instead of on punctuation.
  const { turnstileToken, ...withoutToken } = VALID;
  const parsed = orderSchema.safeParse(withoutToken);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.turnstileToken, "");
});

test("a real token still passes, and surrounding whitespace is not part of it", () => {
  const parsed = orderSchema.safeParse({ ...VALID, turnstileToken: "  0abc.very-long-token  " });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.turnstileToken, "0abc.very-long-token");
});

test("the token is still capped, so it stays a token and not a free-text field", () => {
  const parsed = orderSchema.safeParse({ ...VALID, turnstileToken: "x".repeat(2049) });
  assert.equal(parsed.success, false);
  assert.ok(parsed.error.flatten().fieldErrors.turnstileToken);
});

test("relaxing the token relaxed nothing else", () => {
  // The point of the empty token is that it is the ONLY thing optional. Each of
  // these is a field the customer can get wrong, and each must still be caught
  // before anything is priced or written.
  const bad = [
    ["phone", { phone: "12345" }],
    ["whatsapp", { whatsapp: "not a number" }],
    ["customerName", { customerName: "A" }],
    ["address", { address: "x" }],
    ["state", { state: "L" }],
    ["deliveryDate", { deliveryDate: "someday" }],
    ["paymentMethod", { paymentMethod: "barter" }],
    ["idempotencyKey", { idempotencyKey: "not-a-uuid" }],
    ["productId", { productId: 0 }],
  ] as const;
  for (const [field, override] of bad) {
    const parsed = orderSchema.safeParse({ ...VALID, ...override });
    assert.equal(parsed.success, false, `${field} must be rejected`);
    assert.ok(
      parsed.error.flatten().fieldErrors[field],
      `${field} must be reported against its own field`,
    );
  }
});

test("the client's own price fields are still ignored, not trusted", () => {
  // §8.1: the schema has no price fields, so a client that sends them has them
  // stripped rather than honoured.
  const parsed = orderSchema.safeParse({ ...VALID, amount: 1, subtotal: 1, discountPercent: 90 });
  assert.equal(parsed.success, true);
  assert.equal("amount" in parsed.data, false);
  assert.equal("subtotal" in parsed.data, false);
  assert.equal("discountPercent" in parsed.data, false);
});