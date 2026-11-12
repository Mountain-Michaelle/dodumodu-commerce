// Email provider — spec §6. Resend is called with fetch (no SDK). Behind an
// interface so tests use a stub. Sent inside ctx.waitUntil so the response
// never waits and never changes with email success. Never log the body/code.
import type { Context } from "hono";
import { afterResponse } from "../auth/ctx";
import { scrub } from "../shared/logger";

export interface EmailProvider {
  send(to: string, subject: string, text: string, idempotencyKey: string, html?: string): Promise<boolean>;
}

const EMAIL_TIMEOUT_MS = 10000;

/** Resend provider. One retry with the same idempotency key (spec §6).
 * Returns true on accept, false on provider failure. Never logs code/body. */
export function resendProvider(apiKey: string, from: string): EmailProvider {
  return {
    async send(to, subject, text, idempotencyKey, html?): Promise<boolean> {
      const body = JSON.stringify({ from, to, subject, text, ...(html ? { html } : {}) });
      let lastStatus: number | null = null;
      let lastDetail = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body,
            signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
          });
          lastStatus = res.status;
          if (res.ok) return true;
          lastDetail = await res.text().catch(() => "");
        } catch (e) {
          lastDetail = e instanceof Error ? e.name : "send_error";
        }
      }
      console.error("[auth]", JSON.stringify({
        event: "email_provider_failure",
        operation: "email.send",
        status: lastStatus,
        attempts: 2,
        from_domain: from.split("@")[1] ?? null,
        detail: scrub(lastDetail, 200),
      }));
      return false;
    },
  };
}

/** No-op provider for tests / when no key is set. */
export const nullProvider: EmailProvider = {
  async send(): Promise<boolean> { return true; },
};

/** In-memory mailbox for tests (spec §9/§10): keeps the last code per recipient
 * so a Playwright/attack test can read it without a real Resend call. Only wired
 * in when ALLOW_TEST_IP=1, and only read through a test-gated endpoint. Never
 * used in production (no key + flag off => nullProvider). */
export const testMailbox = new Map<string, { subject: string; text: string; at: number }>();

export const captureProvider: EmailProvider = {
  async send(to, subject, text): Promise<boolean> {
    testMailbox.set(to.toLowerCase(), { subject, text, at: Date.now() });
    return true;
  },
};

/** No API key configured. Fails loudly instead of silently reporting success. */
export const unconfiguredProvider: EmailProvider = {
  async send(): Promise<boolean> {
    console.error("[auth]", JSON.stringify({
      event: "email_not_configured",
      detail: "RESEND_API_KEY is empty or missing: no email was sent. Set it in .env / wrangler secrets.",
    }));
    return false;
  },
};

export function providerFor(apiKey: string | null, from = "auth@example.com"): EmailProvider {
  return apiKey && apiKey.trim() ? resendProvider(apiKey.trim(), from) : unconfiguredProvider;
}

/** The provider the routes use: capture in tests, else Resend/null. */
export function providerForEnv(
  apiKey: string | null, allowTestIp: string | undefined, from = "auth@example.com",
): EmailProvider {
  if (allowTestIp === "1") return captureProvider;
  return providerFor(apiKey, from);
}

/** From address override (env AUTH_FROM_EMAIL). Must be a Resend-verified domain/sender. */
export function fromForEnv(env: Record<string, string | undefined>): string {
  return env.AUTH_FROM_EMAIL ?? "auth@example.com";
}

/** Send inside waitUntil; never throws into the request path. */
export function sendInBackground(
  c: Context, provider: EmailProvider,
  to: string, subject: string, text: string, key: string,
): void {
  void afterResponse(c, provider.send(to, subject, text, key).then((ok) => {
    if (!ok) console.error("[auth]", JSON.stringify({
      event: "email_provider_failure",
      operation: "email.background_send",
      delivery: "rejected",
    }));
  }));
}