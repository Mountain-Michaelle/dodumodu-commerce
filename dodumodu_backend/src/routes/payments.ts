import { Hono } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { paymentService } from "../services/paymentService";

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
      // TODO: send the §5.11 alert (Slack/email/WhatsApp webhook) here.
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
    // TODO: send the §5.11 alert (Slack/email/WhatsApp webhook) here.
  }

  return c.json(result);
});
