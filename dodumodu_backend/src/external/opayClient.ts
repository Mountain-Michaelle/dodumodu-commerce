import { isUsableSecret, secureEqual } from "../shared/secureEqual";
import type { Env } from "../env";
import type { OrderRow } from "../data/ordersRepo";

// IMPORTANT: follow OPay's own current API docs for the exact checkout-creation
// and webhook payload field names before wiring this up for real — they vary
// between merchant regions. This file only enforces the *shape* of the two
// operations the rest of the app depends on; fill in the real request/response
// mapping against the current docs.

function baseUrl(env: Env): string {
  // The OPay host is configuration (OPAY_BASE_URL), not a constant baked into
  // the code: sandbox and production differ, and the value also differs per
  // merchant region, so changing environment must not mean editing a file.
  const configured = (env.OPAY_BASE_URL ?? "").trim();
  if (!configured) throw new Error("OPAY_BASE_URL is not configured.");
  return configured.replace(/\/+$/, "");
}

export type OpayCheckoutResult = {
  checkoutUrl: string;
  opayReference: string;
};

export type OpayWebhookPayload = {
  reference: string;
  amount: number; // kobo
  currency: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  // ...whatever additional fields OPay's current webhook docs specify
  // (e.g. payment method, account identifier) — validate them all in
  // paymentService before applying a transition.
};

export const opayClient = {
  async createCheckoutSession(env: Env, order: Pick<OrderRow, "reference" | "amount" | "currency">): Promise<OpayCheckoutResult> {
    const res = await fetch(`${baseUrl(env)}/api/v1/international/cashier/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPAY_SECRET_KEY}`,
        MerchantId: env.OPAY_MERCHANT_ID,
      },
      body: JSON.stringify({
        reference: order.reference,
        amount: { total: order.amount, currency: order.currency },
        // callbackUrl / returnUrl / productName / customerName etc. — see current OPay docs
      }),
    });

    if (!res.ok) {
      throw new Error(`OPay checkout creation failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json<{ data: { cashierUrl: string; reference: string } }>();
    return { checkoutUrl: data.data.cashierUrl, opayReference: data.data.reference };
  },

  /**
   * A valid signature only proves the message came from OPay — it does not
   * prove its contents match the stored order. Callers must still check
   * amount/currency/status against the order (§5.8, step 3).
   */
  async verifyWebhookSignature(env: Env, rawBody: string, signatureHeader: string | null): Promise<boolean> {
    if (!signatureHeader) return false;
    // A key that is blank or a template placeholder is a key everybody knows: any signature made with it is
    // forgeable, so verification must fail instead of "succeeding" on it.
    if (!isUsableSecret(env.OPAY_WEBHOOK_SECRET)) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.OPAY_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["sign"],
    );
    const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const computed = [...new Uint8Array(sigBytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return secureEqual(computed, signatureHeader.trim().toLowerCase());
  },

  /** Direct status lookup for reconciliation (§5.9) — does not rely on a webhook arriving. */
  async getPaymentStatus(env: Env, reference: string): Promise<OpayWebhookPayload | null> {
    const res = await fetch(`${baseUrl(env)}/api/v1/international/cashier/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPAY_SECRET_KEY}`,
        MerchantId: env.OPAY_MERCHANT_ID,
      },
      body: JSON.stringify({ reference }),
    });
    if (!res.ok) return null;
    return res.json<OpayWebhookPayload>();
  },
};
