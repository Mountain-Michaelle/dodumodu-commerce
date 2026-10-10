// Email provider — spec §6. Resend is called with fetch (no SDK). Behind an
// interface so tests use a stub. Sent inside ctx.waitUntil so the response
// never waits and never changes with email success. Never log the body/code.
import type { Context } from "hono";

export interface EmailProvider {
  send(to: string, subject: string, text: string, idempotencyKey: string): Promise<void>;
}

const EMAIL_TIMEOUT_MS = 3000;

/** Resend provider. One retry with the same idempotency key (spec §6). */
export function resendProvider(apiKey: string, from: string): EmailProvider {
  return {
    async send(to, subject, text, idempotencyKey) {
      const body = JSON.stringify({ from, to, subject, text });
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
          if (res.ok) return;
        } catch {
          // retry once with the same key, then give up (email failure is
          // invisible to the client — the response already returned).
        }
      }
    },
  };
}

/** No-op provider for tests / when no key is set. */
export const nullProvider: EmailProvider = {
  async send() {},
};

export function providerFor(apiKey: string | null, from = "auth@example.com"): EmailProvider {
  return apiKey ? resendProvider(apiKey, from) : nullProvider;
}

/** Send inside waitUntil; never throws into the request path. */
export function sendInBackground(
  c: Context<never>, provider: EmailProvider,
  to: string, subject: string, text: string, key: string,
): void {
  c.executionCtx?.waitUntil?.(provider.send(to, subject, text, key).catch(() => {}));
}

/** The login-code email (code never logged). */
export async function sendLoginCode(
  provider: EmailProvider, to: string, code: string,
): Promise<void> {
  await provider.send(
    to, "Your sign-in code",
    `Your code is ${code}. It expires in 3 minutes. If you did not request it, ignore this email.`,
    `login-code:${to}`,
  );
}
