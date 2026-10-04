import { Hono } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { orderGuard, noteOrderOutcome } from "../middleware/orderGuard";
import { orderSchema } from "../validation/orderSchema";
import { orderService, ProductNotFoundError, PackageNotFoundError, InvalidQuantityError } from "../services/orderService";
import type { OrderRow } from "../data/ordersRepo";
import { CodNotAvailableError } from "../services/codPolicyService";

export const ordersRoute = new Hono<{ Bindings: Env; Variables: { parsedBody: unknown; prefetchedOrder?: OrderRow | null } }>();

// Exported for tests only: the fail-closed rules here are security-relevant, so
// they need to be provable without a real Cloudflare round trip. The schema above
// deliberately does NOT duplicate this decision - see validation/orderSchema.ts.
export async function verifyTurnstile(env: Env, token: string, remoteIp: string) {
  // Local development has no Turnstile secret: there is no widget to solve
  // offline, so verification is skipped - and only there. With
  // ENVIRONMENT=production a missing secret fails closed, exactly like a bad
  // token does, because production must never silently accept an unverified
  // order. Same code both ways; only the configuration differs.
  if (!env.TURNSTILE_SECRET_KEY) {
    if (env.ENVIRONMENT === "production") return false;
    console.warn(JSON.stringify({
      event: "turnstile_skipped", reason: "TURNSTILE_SECRET_KEY is not set (non-production only)",
    }));
    return true;
  }

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: remoteIp }),
  });
  const data = await res.json<{ success: boolean }>();
  return data.success;
}

// Order of checks: body parse -> idempotency + abuse observation (orderGuard) ->
// schema validation -> Turnstile -> service.
//
// The guard runs BEFORE schema validation deliberately, because it must observe
// request activity even for requests that never become a well-formed order - that
// is precisely the traffic a flood produces. It does not reject anything: in the
// shadow phase its verdict is data, and the schema/Turnstile/service chain below
// behaves exactly as it did before the abuse layer existed.
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
  const humanVerified = await verifyTurnstile(c.env, parsed.data.turnstileToken, remoteIp);
  if (!humanVerified) {
    await noteOrderOutcome(c, "turnstile_failed");
    return c.json({ error: "Bot verification failed" }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);
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
    await noteOrderOutcome(c, "created", { status: order.status, id: order.id });
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
    if (err instanceof ProductNotFoundError) return c.json({ error: "Product not found" }, 404);
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

    throw err;
  }
});
