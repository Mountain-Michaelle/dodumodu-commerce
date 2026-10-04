import type { Db } from "../db";
import type { Env } from "../env";
import { ordersRepo, type OrderRow } from "../data/ordersRepo";
import { opayClient, type OpayWebhookPayload } from "../external/opayClient";

const RECONCILE_STALE_MINUTES = 10;
const RECONCILE_ALERT_RETRY_THRESHOLD = 5;

export type WebhookOutcome =
  | { kind: "ignored_bad_signature" }
  | { kind: "order_not_found" }
  | { kind: "mismatch_flagged"; order: OrderRow }
  | { kind: "applied"; order: OrderRow }
  | { kind: "no_op"; order: OrderRow };

export const paymentService = {
  async createCheckout(env: Env, order: OrderRow) {
    const result = await opayClient.createCheckoutSession(env, order);
    return result.checkoutUrl;
  },

  /** §5.8 — full webhook handling pipeline. */
  async handleWebhook(
    db: Db,
    env: Env,
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<WebhookOutcome> {
    const validSignature = await opayClient.verifyWebhookSignature(env, rawBody, signatureHeader);
    if (!validSignature) {
      // Log and return 200 anyway (the route does this) so OPay doesn't retry-storm us.
      return { kind: "ignored_bad_signature" };
    }

    const payload = JSON.parse(rawBody) as OpayWebhookPayload;
    const order = await ordersRepo.findByReference(db, payload.reference);
    if (!order) return { kind: "order_not_found" };

    // A valid signature only proves the message came from OPay — it doesn't
    // prove the contents match this order. Check the business fields.
    const amountMatches = payload.amount === order.amount;
    const currencyMatches = payload.currency === order.currency;
    if (!amountMatches || !currencyMatches) {
      return { kind: "mismatch_flagged", order };
    }

    if (payload.status !== "SUCCESS" && payload.status !== "FAILED") {
      return { kind: "no_op", order };
    }

    const toStatus = payload.status === "SUCCESS" ? "paid" : "failed";
    const { applied, order: updated } = await ordersRepo.applyStatusTransition(
      db, order.id, "awaiting_payment", toStatus, "webhook",
    );
    return applied ? { kind: "applied", order: updated! } : { kind: "no_op", order: updated ?? order };
  },

  /** §5.9 — direct status check for orders stuck in awaiting_payment. */
  async reconcilePending(db: Db, env: Env) {
    const stale = await ordersRepo.findStalePending(db, RECONCILE_STALE_MINUTES);
    const repaired: number[] = [];
    const alerts: { orderId: number; reference: string; reason: string }[] = [];

    for (const order of stale) {
      const status = await opayClient.getPaymentStatus(env, order.reference);
      await ordersRepo.incrementRetryCount(db, order.id);

      if (status && (status.status === "SUCCESS" || status.status === "FAILED")) {
        const toStatus = status.status === "SUCCESS" ? "paid" : "failed";
        const { applied } = await ordersRepo.applyStatusTransition(
          db, order.id, "awaiting_payment", toStatus, "reconcile",
        );
        if (applied) repaired.push(order.id);
      }

      if (order.retryCount + 1 >= RECONCILE_ALERT_RETRY_THRESHOLD) {
        alerts.push({
          orderId: order.id,
          reference: order.reference,
          reason: `retry_count crossed ${RECONCILE_ALERT_RETRY_THRESHOLD} without resolving`,
        });
      }
    }

    return { checked: stale.length, repaired, alerts };
  },
};
