import { Hono } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { paymentService } from "../services/paymentService";

/** §5.11 — alert when something needs operator attention.
 *
 * Sends a notification through every configured channel:
 *   - Slack webhook (REFERRED_SLACK_WEBHOOK_URL): the real push alert.
 *   - WhatsApp contact (SUPPORT_WHATSAPP_URL): logged with the payload so the
 *     operator thread has the context; WhatsApp has no server-send API here.
 *
 * Both channels are optional and independent: a channel that is not configured
 * is skipped silently, so a deployment that wires only one of them still works.
 */
async function sendSection511Alert(env: Env, event: string, detail: Record<string, unknown>) {
  const payload = {
    event,
    ...detail,
    issuedAt: new Date().toISOString(),
  };

  // Slack webhook
  const slackUrl = env.REFERRED_SLACK_WEBHOOK_URL;
  if (slackUrl) {
    try {
      const res = await fetch(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `§5.11 alert: ${event}`, details: payload }),
      });
      if (!res.ok) {
        console.error(`[§5.11] Slack webhook failed: ${res.statusText}`);
      }
    } catch (error) {
      console.error(`[§5.11] Slack webhook error:`, error);
    }
  }

  // WhatsApp support link (informational)
  if (env.SUPPORT_WHATSAPP_URL) {
    console.log(
      JSON.stringify({
        event: "section511_whatsapp_contact",
        whatsappUrl: env.SUPPORT_WHATSAPP_URL,
        details: payload,
      }),
    );
  }
}

export const paymentsRoute = new Hono<{ Bindings: Env }>();

// §5.8 — always return 200 to OPay even on a bad signature/mismatch, so it
// doesn't retry-storm us. The *order* only changes on a clean, verified match.
paymentsRoute.post("/opay-callback", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-opay-signature");
  const db = createDb(c.env.DATABASE_URL);

  const outcome = await paymentService.handleWebhook(db, c.env, rawBody, signature ?? null);

  switch (outcome.kind) {
    case "ignored_bad_signature":
      console.log(JSON.stringify({ event: "payment_webhook_bad_signature" }));
      return c.json({ received: true });
    case "order_not_found":
      console.log(JSON.stringify({ event: "payment_webhook_order_not_found" }));
      return c.json({ received: true });
    case "mismatch_flagged":
      console.log(JSON.stringify({
        event: "payment_amount_mismatch_flagged", reference: outcome.order.reference,
      }));
      await sendSection511Alert(c.env, "payment_amount_mismatch_flagged", {
        reference: outcome.order.reference,
        orderId: outcome.order.id,
      });
      return c.json({ received: true });
    case "applied":
      console.log(JSON.stringify({
        event: "payment_webhook_verified", reference: outcome.order.reference, status: outcome.order.status,
      }));
      return c.json({ received: true });
    case "no_op":
      return c.json({ received: true });
  }
});

// cron-job.org hits this every 5 minutes with a shared secret header — not a
// public route, and not a Workers Cron Trigger (per the stack table in §1).
paymentsRoute.post("/reconcile-pending", async (c) => {
  const secret = c.req.header("x-cron-secret");
  if (secret !== c.env.RECONCILE_CRON_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const db = createDb(c.env.DATABASE_URL);
  const result = await paymentService.reconcilePending(db, c.env);

  if (result.repaired.length > 0) {
    console.log(JSON.stringify({ event: "reconcile_repaired", orderIds: result.repaired }));
  }
  for (const alert of result.alerts) {
    console.log(JSON.stringify({ event: "reconcile_alert_threshold", ...alert }));
    await sendSection511Alert(c.env, "reconcile_alert_threshold", {
      orderId: alert.orderId,
      reference: alert.reference,
      reason: alert.reason,
    });
  }

  return c.json(result);
});