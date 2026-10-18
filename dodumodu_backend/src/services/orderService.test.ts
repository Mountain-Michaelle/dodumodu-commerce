import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../db";
import type { Env } from "../env";
import type { OrderInput } from "../validation/orderSchema";
import { orderService, ProductNotFoundError, InvalidQuantityError, PaymentUnavailableError, PaymentMethodMismatchError } from "./orderService";
import { CodNotAvailableError } from "./codPolicyService";
import { ordersRepo } from "../data/ordersRepo";
import { productsRepo } from "../data/productsRepo";
import { discountTiersRepo } from "../data/discountTiersRepo";
import { paymentRulesRepo, CLOSED_PAYMENT_RULES } from "../data/paymentRulesRepo";
import { paymentService } from "./paymentService";

/* The COD gate is the one place where a hostile client can actually cost money:
   a refused delivery is a lost parcel. codPolicyService.test.ts proves the
   decision function; this file proves createOrder actually calls it, refuses
   BEFORE writing anything, and cannot be talked out of it by the request body.
   The repos are plain objects, so they are stubbed in place - no database. */
const db = {} as Db;
const env = { MAX_ORDER_QUANTITY: "20" } as unknown as Env;

const PRODUCT = { id: 1, slug: "glow-serum", name: "Glow", price: 1500000, packageOptions: [], active: true };
const TIERS = [{ id: 1, minQuantity: 2, discountPercent: 10, label: "Buy 2, save 10%", active: true }];

let inserted: unknown[] = [];
let rules = { codStates: ["Lagos", "Ogun", "Enugu", "Abuja"], codBulkThreshold: 5 };

function stubRepos() {
  ordersRepo.findByIdempotencyKey = async () => null;
  ordersRepo.insert = async (_db, row) => {
    inserted.push(row);
    return { id: inserted.length, ...row } as never;
  };
  // Written after the insert; without this the status-history INSERT reaches for
  // a real database connection.
  ordersRepo.writeStatusHistory = async () => undefined;
  productsRepo.findById = async () => PRODUCT as never;
  discountTiersRepo.findActive = async () => TIERS as never;
  paymentRulesRepo.get = async () => rules;
  // A pay-now order would otherwise try to reach the payment provider.
  paymentService.createCheckout = async () => "https://pay.test/checkout";
}
stubRepos();

function order(over: Partial<OrderInput> = {}): OrderInput {
  return {
    productId: 1,
    idempotencyKey: `key-${Math.random()}`,
    quantity: 1,
    customerName: "Chioma Adeyemi",
    phone: "08012345678",
    whatsapp: "08012345678",
    address: "12 Allen Avenue, Ikeja",
    state: "Lagos",
    deliveryDate: "tomorrow",
    paymentMethod: "cod",
    turnstileToken: "t",
    ...over,
  } as OrderInput;
}

test.beforeEach(() => {
  inserted = [];
  rules = { codStates: ["Lagos", "Ogun", "Enugu", "Abuja"], codBulkThreshold: 5 };
});

test("a COD order in an eligible state is accepted and written", async () => {
  const { order: created } = await orderService.createOrder(db, env, order({ state: "Lagos", quantity: 2 }));
  assert.equal(created.paymentMethod, "cod");
  assert.equal(created.status, "confirmed_cod");
  assert.equal(inserted.length, 1);
});

test("the reference is always ddmd- plus 15 unique hex chars: recognizable, non-guessable", async () => {
  await orderService.createOrder(db, env, order({ state: "Lagos" }));
  const reference = (inserted[0] as { reference: string }).reference;
  // A customer reads this back over the phone or types it into WhatsApp. The
  // fixed `ddmd-` prefix makes it recognizable in a thread or pasted sheet,
  // and 15 random hex chars (~1.15 quintillion) mean the sequence cannot be
  // walked and id conflicts are practically impossible.
  assert.equal(reference, reference.toLowerCase(), `reference must be lowercase: ${reference}`);
  assert.match(reference, /^ddmd-[0-9a-f]{15}$/, `reference must be ddmd- + 15 hex chars: ${reference}`);
});

test("references do not repeat, so the UNIQUE constraint is a backstop not a lottery", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) {
    await orderService.createOrder(db, env, order({ state: "Lagos" }));
    seen.add((inserted[i] as { reference: string }).reference);
  }
  assert.equal(seen.size, 25, "25 orders must produce 25 distinct references");
});

test("COD outside the eligible states is refused, and nothing is written", async () => {
  await assert.rejects(
    () => orderService.createOrder(db, env, order({ state: "Kano" })),
    (err: unknown) => err instanceof CodNotAvailableError && err.reason === "state",
  );
  assert.equal(inserted.length, 0, "no order row may exist for a refused COD order");
});

test("COD at or above the bulk ceiling is refused, and nothing is written", async () => {
  for (const quantity of [5, 6, 20]) {
    await assert.rejects(
      () => orderService.createOrder(db, env, order({ state: "Lagos", quantity })),
      (err: unknown) => err instanceof CodNotAvailableError && err.reason === "bulk",
      `quantity ${quantity} must pay before dispatch`,
    );
  }
  assert.equal(inserted.length, 0);
});

test("raising the ceiling in the database relaxes the gate with no redeploy", async () => {
  rules = { codStates: ["Lagos"], codBulkThreshold: 10 };
  const { order: created } = await orderService.createOrder(db, env, order({ state: "Lagos", quantity: 7 }));
  assert.equal(created.quantity, 7);
  assert.equal(inserted.length, 1);
});

test("a missing rules row closes COD rather than opening it", async () => {
  paymentRulesRepo.get = async () => CLOSED_PAYMENT_RULES;
  await assert.rejects(
    () => orderService.createOrder(db, env, order({ state: "Lagos" })),
    (err: unknown) => err instanceof CodNotAvailableError,
  );
  assert.equal(inserted.length, 0);
  paymentRulesRepo.get = async () => rules;
});

test("the same order paid for up front is always accepted", async () => {
  // The gate must never block a paying customer, in any state, at any quantity.
  for (const [state, quantity] of [["Kano", 1], ["Lagos", 20], ["Other", 7]] as const) {
    const { order: created } = await orderService.createOrder(
      db, env, order({ state, quantity, paymentMethod: "pay_now" }),
    );
    assert.equal(created.status, "awaiting_payment", `${state} x${quantity} paid up front`);
  }
});

test("the quantity ceiling is still enforced before the payment gate", async () => {
  await assert.rejects(
    () => orderService.createOrder(db, env, order({ state: "Lagos", quantity: 21, paymentMethod: "pay_now" })),
    (err: unknown) => err instanceof InvalidQuantityError,
  );
});

test("an unknown product is refused before anything else happens", async () => {
  productsRepo.findById = async () => null as never;
  await assert.rejects(
    () => orderService.createOrder(db, env, order()),
    (err: unknown) => err instanceof ProductNotFoundError,
  );
  assert.equal(inserted.length, 0);
  productsRepo.findById = async () => PRODUCT as never;
});

test("a checkout failure writes NOTHING, so no zombie can hold the key hostage", async () => {
  // The provider call used to run AFTER the insert: OPay rejecting it left a
  // pay_now/awaiting_payment row behind, and every later attempt with that key
  // — even a COD one — replayed the dead order instead of creating a real one.
  paymentService.createCheckout = async () => { throw new Error("OPay 401"); };
  await assert.rejects(
    () => orderService.createOrder(db, env, order({ paymentMethod: "pay_now" })),
    (err: unknown) => err instanceof PaymentUnavailableError,
  );
  assert.equal(inserted.length, 0, "a failed checkout must leave no order row");
  paymentService.createCheckout = async () => "https://pay.test/checkout";
});

test("a key replayed with a different payment method is refused, not answered with the old order", async () => {
  ordersRepo.findByIdempotencyKey = async () =>
    ({ id: 7, paymentMethod: "pay_now", status: "awaiting_payment" }) as never;
  await assert.rejects(
    () => orderService.createOrder(db, env, order({ paymentMethod: "cod" })),
    (err: unknown) => err instanceof PaymentMethodMismatchError,
  );
  assert.equal(inserted.length, 0, "a mismatched replay must not write a second order");
  ordersRepo.findByIdempotencyKey = async () => null;
});

test("a same-method replay still returns the stored order and writes nothing", async () => {
  const stored = { id: 9, paymentMethod: "cod", status: "confirmed_cod" } as never;
  ordersRepo.findByIdempotencyKey = async () => stored;
  const { order: created } = await orderService.createOrder(db, env, order());
  assert.equal(created, stored, "the stored order wins — first successfully created order, full stop");
  assert.equal(inserted.length, 0, "a replay must not insert a duplicate");
  ordersRepo.findByIdempotencyKey = async () => null;
});
