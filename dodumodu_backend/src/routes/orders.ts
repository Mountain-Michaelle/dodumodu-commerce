import { decideHold, evaluateRpf } from "../abuse/spamDiversion";
import { Hono } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { orderGuard, noteOrderOutcome } from "../middleware/orderGuard";
import { orderSchema } from "../validation/orderSchema";
import { orderService, ProductNotFoundError, PackageNotFoundError, InvalidQuantityError, PaymentUnavailableError, PaymentMethodMismatchError } from "../services/orderService";
import { ordersRepo, type OrderRow } from "../data/ordersRepo";
import { productsRepo } from "../data/productsRepo";
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
// timeout and reported as its own outcome ("unavailable"). The route FAILS OPEN on it: the order is accepted and flagged
// "unverified" for review, because losing a real customer to a verifier problem costs more than reviewing one order.
// Only a definitive refusal ("failed": the token is not one Cloudflare issued) is rejected.
const TURNSTILE_TIMEOUT_MS = 3_000;

const SOFT_CODES = new Set([
  "timeout-or-duplicate", "internal-error", "invalid-input-secret", "missing-input-secret", "bad-request", "invalid-widget-id",
]);

export async function verifyTurnstileOutcome(
  env: Env, token: string, remoteIp: string, idempotencyKey?: string, detail?: { codes?: string[] },
): Promise<TurnstileOutcome> {
  // Local development has no Turnstile secret: there is no widget to solve
  // offline, so verification is skipped - and only there. With
  // ENVIRONMENT=production a missing secret fails closed, exactly like a bad
  // token does, because production must never silently accept an unverified
  // order. Same code both ways; only the configuration differs.
  if (!env.TURNSTILE_SECRET_KEY) {
    // Fail open (flagged): a missing secret is OUR configuration problem, never a reason to refuse a customer.
    if (env.ENVIRONMENT === "production") return "unavailable";
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
      // idempotency_key lets Cloudflare answer the SAME token again for the SAME order: a customer's automatic retry after
      // a dropped connection or a 503 reuses the token, and without this it would be refused as already spent.
      // (Cloudflare accepts at most 36 characters; anything else is simply not sent.)
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: remoteIp,
        ...(idempotencyKey && /^[0-9A-Za-z-]{8,36}$/.test(idempotencyKey) ? { idempotency_key: idempotencyKey } : {}),
      }),
    });
    if (res.status >= 500) { if (detail) detail.codes = [`http-${res.status}`]; return "unavailable"; }
    const data = await res.json<{ success: boolean; "error-codes"?: string[] }>();
    if (!data.success) {
      // Cloudflare says WHY (invalid-input-secret = wrong secret key, timeout-or-duplicate = token reused/expired,
      // invalid-input-response = bad token). Logged and handed back so a refusal is never a mystery.
      if (detail) detail.codes = data["error-codes"] ?? [];
      console.warn(JSON.stringify({ event: "turnstile_refused", codes: data["error-codes"] ?? [] }));
    }
    if (data.success) return "ok";
    // An EXPIRED or already-spent token, a Cloudflare-side error, or our own wrong secret says nothing about the customer
    // being a bot: soft. Only a token Cloudflare does not recognise at all is a definitive refusal.
    const codes = data["error-codes"] ?? [];
    const soft = codes.length === 0 || codes.some((x) => SOFT_CODES.has(x));
    return soft ? "unavailable" : "failed";
  } catch (err) {
    console.warn(JSON.stringify({
      event: "turnstile_unavailable",
      reason: err instanceof Error ? err.name : "unknown",
    }));
    if (detail) detail.codes = [err instanceof Error ? err.name : "unknown"];
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
const UNVERIFIED_PER_IP_PER_HOUR = 8;

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
  const db = createDb(c.env.DATABASE_URL);
  const prefetched = c.get("prefetchedOrder") ?? null;
  // A REPLAY of an order that already exists (the guard found it by idempotency key) creates nothing. If that order went
  // through flagged (no token yet) and this retry brings a token, the token is checked and the SAME order is upgraded to
  // "verified" - the customer's page then proceeds to the thank-you page. Nothing is ever created twice.
  const isReplay = prefetched !== null;

  // Honeypot: a field no person can see. A bot that fills every input is dropped here, and gets a plausible answer so it
  // learns nothing. (Counted in the abuse observations; nothing is stored.)
  if ((parsed.data.website ?? "").trim() !== "") {
    await noteOrderOutcome(c, "validation_failed");
    return c.json({
      orderId: HELD_ORDER_ID_BASE, reference: "", status: "confirmed_cod", flaggedLate: false, packageId: parsed.data.packageId ?? null,
      quantity: parsed.data.quantity, unitPrice: 0, subtotal: 0, discountPercent: 0, discountAmount: 0, amount: 0, botCheck: "verified",
    });
  }

  const product = await productsRepo.findById(db, parsed.data.productId).catch(() => null);
  const checkEnabled = product?.botCheckEnabled !== false;
  const token = parsed.data.turnstileToken;

  let botCheck: "verified" | "missing" | "unverified" | "off" = "off";
  if (checkEnabled && (!isReplay || (prefetched.botCheck !== "verified" && prefetched.botCheck !== "off"))) {
    if (!token) {
      botCheck = "missing";
    } else {
      const why: { codes?: string[] } = {};
      const outcome = await verifyTurnstileOutcome(c.env, token, remoteIp, parsed.data.idempotencyKey, why);
      const detail = (why.codes ?? []).join(",").slice(0, 120);
      if (outcome === "failed") {
        // A token Cloudflare does not recognise. The page treats this as "no token" and sends the order once more without
        // one, so a real customer is never stranded here; a bot gains nothing it did not already have by omitting it.
        await noteOrderOutcome(c, "turnstile_failed");
        return c.json({ error: "Bot verification failed", code: "turnstile_failed", detail }, 400);
      }
      botCheck = outcome === "ok" ? "verified" : "unverified";
    }
  } else if (isReplay) {
    botCheck = (prefetched.botCheck as typeof botCheck | null) ?? "off";
  }

  // Fail-open needs brakes: one address cannot push unlimited unverified orders through. (Generous, because many phones
  // share one mobile-network address; the honeypot, the spam rules below and a person reviewing flagged orders do the rest.)
  if (!isReplay && (botCheck === "missing" || botCheck === "unverified") && remoteIp) {
    const recent = await ordersRepo.unverifiedFromIpInLastHour(db, remoteIp).catch(() => 0);
    if (recent >= UNVERIFIED_PER_IP_PER_HOUR) {
      await noteOrderOutcome(c, "validation_failed");
      c.header("Retry-After", "600");
      return c.json({ error: "Too many orders from this connection. Please message us on WhatsApp to order.", code: "rate_limited" }, 429);
    }
  }
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
          botCheck: "verified", // held spam is finished as far as the page is concerned: never loops on a bot check
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
      botCheck,
    // Legitimate progression is the negative evidence that disarms the abuse rules
    });
    // for this address, recorded from the order the server actually created.
    created = true;
    if (isReplay && botCheck === "verified" && order.botCheck !== "verified") {
      await ordersRepo.setBotCheck(db, order.id, "verified").catch(swallow("orders_best_effort_failed"));
    }
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
      botCheck,
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
