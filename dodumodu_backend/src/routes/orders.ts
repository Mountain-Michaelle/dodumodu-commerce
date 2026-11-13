import { decideHold, evaluateRpf } from "../abuse/spamDiversion";
import { Hono } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { orderGuard, noteOrderOutcome } from "../middleware/orderGuard";
import { orderSchema } from "../validation/orderSchema";
import { orderService, ProductNotFoundError, PackageNotFoundError, InvalidQuantityError, PaymentUnavailableError, PaymentMethodMismatchError } from "../services/orderService";
import type { OrderRow } from "../data/ordersRepo";
import { CodNotAvailableError } from "../services/codPolicyService";
import { sendInBackground, sendOrderBackup, sendOrderFailureAlert } from "../services/orderBackupMailer";
import { swallow } from "../shared/logger";

export const ordersRoute = new Hono<{ Bindings: Env; Variables: { parsedBody: unknown; prefetchedOrder?: OrderRow | null } }>();

// Exported for tests only: the fail-closed rules here are security-relevant, so
// they need to be provable without a real Cloudflare round trip. The schema above
// deliberately does NOT duplicate this decision - see validation/orderSchema.ts.
export type TurnstileOutcome = "ok" | "failed" | "unavailable";

// Cloudflare's verifier is reached from the Worker, not from the customer's phone, but
// it can still be slow or briefly down. A hung or erroring verifier must never become
// an unhandled 500 that the storefront reads as "your order failed": it is bounded by a
// timeout and reported as its own outcome ("unavailable") so the route can answer a
// retryable 503. It still FAILS CLOSED - an unverified order is never accepted.
const TURNSTILE_TIMEOUT_MS = 8_000;

export async function verifyTurnstileOutcome(env: Env, token: string, remoteIp: string): Promise<TurnstileOutcome> {
  // Local development has no Turnstile secret: there is no widget to solve
  // offline, so verification is skipped - and only there. With
  // ENVIRONMENT=production a missing secret fails closed, exactly like a bad
  // token does, because production must never silently accept an unverified
  // order. Same code both ways; only the configuration differs.
  if (!env.TURNSTILE_SECRET_KEY) {
    if (env.ENVIRONMENT === "production") return "failed";
    console.warn(JSON.stringify({
      event: "turnstile_skipped", reason: "TURNSTILE_SECRET_KEY is not set (non-production only)",
    }));
    return "ok";
  }
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: remoteIp }),
    });
    if (res.status >= 500) return "unavailable";
    const data = await res.json<{ success: boolean }>();
    return data.success ? "ok" : "failed";
  } catch (err) {
    console.warn(JSON.stringify({
      event: "turnstile_unavailable",
      reason: err instanceof Error ? err.name : "unknown",
    }));
    return "unavailable";
  }
}

export async function verifyTurnstile(env: Env, token: string, remoteIp: string) {
  return (await verifyTurnstileOutcome(env, token, remoteIp)) === "ok";
}

// Order of checks: body parse -> idempotency + abuse observation (orderGuard) ->
// schema validation -> Turnstile -> service.
//
// The guard runs BEFORE schema validation deliberately, because it must observe
// request activity even for requests that never become a well-formed order - that
// is precisely the traffic a flood produces. It does not reject anything: in the
// shadow phase its verdict is data, and the schema/Turnstile/service chain below
// behaves exactly as it did before the abuse layer existed.
// A held order has no row in `orders`; this offset keeps the id the storefront is handed clearly apart from real ones.
const HELD_ORDER_ID_BASE = 1_000_000_000;

ordersRoute.post("/create-order", orderGuard, async (c) => {
  const body = c.get("parsedBody");
  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) {
    // A malformed body is an INPUT QUALITY problem, not proof of abuse. It is
    // recorded so the shadow report can show how much traffic fails to parse, and
    // it is never on its own a reason to refuse anybody.
    await noteOrderOutcome(c, "validation_failed");
    return c.json({ error: "Invalid request", fields: parsed.error.flatten().fieldErrors }, 400);
  }

  const remoteIp = c.req.header("cf-connecting-ip") ?? "";
  // A REPLAY of an order that already exists (the guard found it by idempotency key)
  // creates nothing, so there is nothing for a bot check to protect - and a Turnstile
  // token is single-use. A customer on a bad connection whose first request succeeded
  // but whose response was lost retries with the SAME token; re-verifying it would
  // answer "Bot verification failed" for an order that was in fact placed.
  const isReplay = (c.get("prefetchedOrder") ?? null) !== null;
  if (!isReplay) {
    const outcome = await verifyTurnstileOutcome(c.env, parsed.data.turnstileToken, remoteIp);
    if (outcome === "unavailable") {
      // Our verifier is the problem, not the customer: say so, and ask for a retry.
      c.header("Retry-After", "2");
      return c.json({ error: "Verification is temporarily unavailable. Please try again in a moment." }, 503);
    }
    if (outcome !== "ok") {
      await noteOrderOutcome(c, "turnstile_failed");
      return c.json({ error: "Bot verification failed" }, 400);
    }
  }

  const db = createDb(c.env.DATABASE_URL);
  const reqMeta = { ip: remoteIp || null, deviceId: c.get("deviceId") ?? null, clientKind: c.get("clientKind") ?? null, browser: c.get("browser") ?? null };

  // Verified spam (one unproven phone flooding the form) is HELD instead of stored: the customer still sees the normal
  // thank-you page, the order is emailed to SPAM_ORDER_EMAIL and listed under Abuse & spam, and an admin can release it.
  // Every doubt - a returning customer, a replay, a mail or database problem - resolves to "store it normally".
  // Held orders skip the regular backup email below: they are announced on the spam address only.
  if (!isReplay) {
    try {
      const hold = await decideHold(db, c.env, parsed.data, reqMeta);
      if (hold.hold) {
        const view = hold.view;
        return c.json({
          orderId: HELD_ORDER_ID_BASE + hold.held.id,
          reference: hold.held.reference,
          status: "confirmed_cod",
          flaggedLate: view.flaggedLate, packageId: view.packageId, quantity: view.quantity, unitPrice: view.unitPrice,
          subtotal: view.subtotal, discountPercent: view.discountPercent, discountAmount: view.discountAmount, amount: view.amount,
          checkoutUrl: undefined,
        });
      }
    } catch (err) {
      // The request is invalid (bad product/package/quantity): it is refused exactly as a stored order would be.
      if (err instanceof ProductNotFoundError) return c.json({ error: "Product not found" }, 404);
      if (err instanceof PackageNotFoundError) return c.json({ error: "Invalid package selected" }, 400);
      if (err instanceof InvalidQuantityError) return c.json({ error: "Invalid request", fields: { quantity: [err.message] } }, 400);
      throw err;
    }
  }
  // Safety net, started NOW and never awaited: the order is emailed in parallel with the
  // database write, so it exists somewhere even if the write is rejected. A replay sends
  // again on purpose - Resend's idempotency key makes that a no-op if the first one went out.
  const mailMeta = { ip: remoteIp || null, clientKind: c.get("clientKind") ?? null };
  sendInBackground(c, sendOrderBackup(c.env, parsed.data, mailMeta));
  let created = false;
  try {
    const { order, checkoutUrl } = await orderService.createOrder(db, c.env, parsed.data, {
      // The row the guard already found, so a replay does not repeat the lookup.
      prefetched: c.get("prefetchedOrder") ?? null,
      // The same header the abuse layer keyed on, so the two cannot disagree about
      // which address an order came from.
      ip: remoteIp || null,
      // Declared device token and coarse client kind, both already validated by the
      // guard. Read from the context rather than the request again, so the value
      // stored on the order is exactly the one that was observed.
      deviceId: c.get("deviceId") ?? null,
      clientKind: c.get("clientKind") ?? null,
    // Legitimate progression is the negative evidence that disarms the abuse rules
    });
    // for this address, recorded from the order the server actually created.
    created = true;
    // Bookkeeping must never turn a saved order into a failure for the customer.
    await noteOrderOutcome(c, "created", { status: order.status, id: order.id }).catch(swallow("orders_best_effort_failed"));
    // A device or address spreading orders over many different phones is raised as an alert for a person to judge;
    // it runs after the response is decided, never delays it, and never touches the order beyond a tag.
    sendInBackground(c, evaluateRpf(db, c.env, reqMeta));
    // Never echo back any price-related field the client sent - every field
    // below is the value the server computed, so the thank-you page can show
    // an accurate breakdown without recomputing anything itself.
    return c.json({
      orderId: order.id,
      reference: order.reference,
      status: order.status,
      flaggedLate: order.flaggedLate,
      packageId: order.packageId,
      quantity: order.quantity,
      unitPrice: order.unitPrice,
      subtotal: order.subtotal,
      discountPercent: order.discountPercent,
      discountAmount: order.discountAmount,
      amount: order.amount,
      checkoutUrl,
    });
  } catch (err) {
    const failed = (reason: string) => {
      if (!created) {
        sendInBackground(c, sendOrderFailureAlert(c.env, db, parsed.data, mailMeta, reason,
          err instanceof Error ? err.message : String(err)));
      }
    };
    if (err instanceof ProductNotFoundError) { failed("product_not_found"); return c.json({ error: "Product not found" }, 404); }
    if (err instanceof PackageNotFoundError) return c.json({ error: "Invalid package selected" }, 400);
    if (err instanceof InvalidQuantityError) {
      return c.json({ error: "Invalid request", fields: { quantity: [err.message] } }, 400);
    }
    if (err instanceof CodNotAvailableError) {
      // Same shape as a schema failure on purpose: fields.paymentMethod[0] is
      // the exact string orchestrate.js prints under the payment field, which is
      // also the string codRules.js predicts with - so the warning shown before
      // submit and the one shown after can never drift apart.
      return c.json({
        error: err.message,
        fields: { paymentMethod: [err.message] },
        codReason: err.reason,
      }, 400);
    }
    if (err instanceof PaymentUnavailableError) {
      // Pay Now can't proceed (OPay not configured, or provider down).
      // Return 400 so the client shows a real message instead of a 500.
      failed("payment_unavailable");
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof PaymentMethodMismatchError) {
      // The idempotency key is being replayed with a different payment method:
      // the stored order is a different intent than this request. 400 (not 409)
      // on purpose — the client treats every non-429 rejection as terminal and
      // drops the key, so the very next submit starts clean.
      return c.json({ error: err.message }, 400);
    }

    // Anything else - including the database rejecting the order - is a lost order unless
    // someone is told: send the full payload to the admin before the 500 goes out.
    failed("order_not_saved");
    throw err;
  }
});
