import type { Db } from "../db";
import type { Env } from "../env";
import { ordersRepo, type OrderRow } from "../data/ordersRepo";
import { productsRepo } from "../data/productsRepo";
import { discountTiersRepo } from "../data/discountTiersRepo";
import { paymentRulesRepo } from "../data/paymentRulesRepo";
import { deliveryService } from "./deliveryService";
import { discountService } from "./discountService";
import { paymentService } from "./paymentService";
import { codPolicyService, CodNotAvailableError } from "./codPolicyService";
import type { OrderInput } from "../validation/orderSchema";
import { normalizePhone } from "../shared/normalizePhone";

export class ProductNotFoundError extends Error {}
export class PackageNotFoundError extends Error {}
export class InvalidQuantityError extends Error {}

type PackageOption = { id: string; label: string; price?: number };

function computeUnitPrice(product: { price: number; packageOptions: unknown }, packageId: string | undefined): number {
  const options = (product.packageOptions as PackageOption[]) ?? [];
  if (!packageId) {
    if (options.length > 0) throw new PackageNotFoundError("packageId required for this product");
    return product.price;
  }
  const chosen = options.find((o) => o.id === packageId);
  if (!chosen) throw new PackageNotFoundError(packageId);
  return chosen.price ?? product.price;
}

function generateReference(): string {
  // Always `ddmd-` + 15 unique lowercase hex chars: recognizable in a WhatsApp
  // thread or a pasted sheet, and with 16^15 (~1.15 quintillion) possibilities
  // it is non-guessable and id conflicts are practically impossible - about a
  // billion-in-a-billion chance only after ~1.2 billion orders. crypto.randomUUID
  // is the entropy source; the orders.reference UNIQUE constraint in 0000_init
  // stays the final authority, which is why creation retries on conflict.
  return `ddmd-${crypto.randomUUID().replaceAll("-", "").slice(0, 15)}`;
}

export const orderService = {
  async createOrder(
    db: Db,
    env: Env,
    input: OrderInput,
    // A row already found by the order guard's idempotency lookup. Passing it here
    // avoids paying for the SAME query twice on the one request that can be a
    // replay. It is optional and defaults to null, so every existing caller is
    // unaffected - and when it IS absent this method still does its own lookup
    // exactly as before. The database UNIQUE constraint on idempotency_key remains
    // the final authority in either case: this is an optimization that saves a
    // round trip, not a second source of truth.
    options: {
      prefetched?: OrderRow | null;
      ip?: string | null;
      deviceId?: string | null;
      clientKind?: string | null;
    } = {},
  ): Promise<{ order: OrderRow; checkoutUrl?: string }> {
    // Fast path for an obvious retry. This is an optimization, NOT the protection —
    // see the catch below for what actually guarantees exactly-once. This also means:
    // a retry with a DIFFERENT quantity than the original request is still ignored —
    // the first successfully created order wins, full stop.
    const existing = options.prefetched !== undefined && options.prefetched !== null
      ? options.prefetched
      : await ordersRepo.findByIdempotencyKey(db, input.idempotencyKey);
    if (existing) {
      const checkoutUrl = existing.paymentMethod === "pay_now" && existing.status === "awaiting_payment"
        ? await paymentService.createCheckout(env, existing)
        : undefined;
      return { order: existing, checkoutUrl };
    }

    const product = await productsRepo.findById(db, input.productId);
    if (!product || !product.active) throw new ProductNotFoundError(String(input.productId));

    const maxQuantity = parseInt(env.MAX_ORDER_QUANTITY, 10);
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > maxQuantity) {
      throw new InvalidQuantityError(`quantity must be an integer between 1 and ${maxQuantity}`);
    }

    // §5.13 — pay-on-delivery is a privilege, not a default: eligible states
    // only, and only up to a bulk-quantity ceiling. Recomputed from the request
    // and the live rules; the browser only hides the option, it is never the
    // authority. A duplicate retry returns above this point on purpose — the
    // first successfully created order stands even if the rules have since
    // changed (§8.7: an order never gets re-judged after the fact).
    if (input.paymentMethod === "cod") {
      const rules = await paymentRulesRepo.get(db);
      const decision = codPolicyService.decideCod(input.state, input.quantity, rules);
      if (!decision.allowed) {
        console.log(JSON.stringify({
          event: "cod_denied", reason: decision.reason,
          state: input.state, quantity: input.quantity,
        }));
        throw new CodNotAvailableError(decision.message, decision.reason);
      }
    }

    // NEVER read subtotal/discountPercent/discountAmount/amount from the request. Ever. §8.1.

    const unitPrice = computeUnitPrice(product, input.packageId);
    const tiers = await discountTiersRepo.findActive(db);
    const { subtotal, discountPercent, discountAmount, amount } = discountService.computePriceBreakdown(
      unitPrice, input.quantity, tiers,
    );

    const deliveryFeeType = deliveryService.getDeliveryFee(input.state);
    const { flaggedLate } = deliveryService.validateSubmittedDate(new Date(), input.deliveryDate);
    const reference = generateReference();

    let order: OrderRow;
    try {
      order = await ordersRepo.insert(db, {
        productId: input.productId,
        idempotencyKey: input.idempotencyKey,
        customerName: input.customerName,
        phone: input.phone,
        // The canonical identity, written HERE with the one shared normalizer so that
        // order history, suspect detection and the spam flag all key on the same
        // value. NULL when the number could not be canonically resolved, which
        // excludes the row from identity-based checks - it fails open, and the
        // order itself is entirely unaffected.
        phoneNorm: normalizePhone(input.phone),
        // The submitting address, recorded so abuse evidence can be shown ON this
        // order. It is not an identity and never a restriction key; the console
        // shows it masked. Null when the header was absent.
        createdFromIp: options.ip ?? null,
        // The client-declared device token, validated at the edge (see
        // readDeviceId in orderGuard). Null when absent or unusable, which excludes
        // the row from V1 - it is evidence about a machine, not about a person.
        deviceId: options.deviceId ?? null,
        // Coarse in-app / browser / unknown. Never the raw User-Agent string.
        clientKind: options.clientKind ?? null,
        whatsapp: input.whatsapp,
        address: input.address,
        state: input.state,
        deliveryFeeType,
        deliveryDate: input.deliveryDate,
        flaggedLate,
        questionNotes: input.questionNotes ?? null,
        paymentMethod: input.paymentMethod,
        packageId: input.packageId ?? null,
        quantity: input.quantity,
        unitPrice,
        subtotal,
        discountPercent,
        discountAmount,
        amount,
        reference,
        status: input.paymentMethod === "cod" ? "confirmed_cod" : "awaiting_payment",
      });
    } catch (err: unknown) {
      // Two requests raced past the `existing` check above at the same instant.
      // The DB's UNIQUE constraint on idempotency_key is the real authority.
      if (isUniqueViolation(err, "idempotency_key")) {
        const winner = await ordersRepo.findByIdempotencyKey(db, input.idempotencyKey);
        if (winner) return { order: winner };
      }
      throw err;
    }

    await ordersRepo.writeStatusHistory(db, order.id, null, order.status, "system");
    console.log(JSON.stringify({
      event: "order_created", reference: order.reference,
      quantity: order.quantity, discountPercent: order.discountPercent,
    }));

    if (input.paymentMethod === "pay_now") {
      const checkoutUrl = await paymentService.createCheckout(env, order);
      return { order, checkoutUrl };
    }

    return { order };
  },
};

function isUniqueViolation(err: unknown, columnHint: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("unique") && message.includes(columnHint);
}
