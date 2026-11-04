// Email provider — spec §6. Resend is called with fetch (no SDK). Behind an
// interface so tests use a stub. Sent inside ctx.waitUntil so the response
// never waits and never changes with email success. Never log the body/code.
import type { Context } from "hono";
import { afterResponse } from "./ctx";

export interface EmailProvider {
  send(to: string, subject: string, text: string, idempotencyKey: string): Promise<boolean>;
}

const EMAIL_TIMEOUT_MS = 10000;

/** Resend provider. One retry with the same idempotency key (spec §6).
 * Returns true on accept, false on provider failure. Never logs code/body. */
export function resendProvider(apiKey: string, from: string): EmailProvider {
  return {
    async send(to, subject, text, idempotencyKey): Promise<boolean> {
      const body = JSON.stringify({ from, to, subject, text });
      let lastStatus: number | null = null;
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
        } catch {
          // retry once with the same key, then give up
        }
      }
      console.error("[auth]", JSON.stringify({
        event: "email_provider_failure",
        operation: "email.send",
        status: lastStatus,
        attempts: 2,
      }));
      return false;
    },
  };
}

/** No-op provider for tests / when no key is set. */
export const nullProvider: EmailProvider = {
  async send(): Promise<boolean> { return true; },
};

/**
 * In-memory mailbox for tests (spec §9/§10): keeps the last code per recipient
 * so a Playwright/attack test can read it without a real Resend call. Only wired
 * in when ALLOW_TEST_IP=1, and only read through a test-gated endpoint. Never
 * used in production (no key + flag off => nullProvider).
 */
export const testMailbox = new Map<string, { subject: string; text: string; at: number }>();

export const captureProvider: EmailProvider = {
  async send(to, subject, text): Promise<boolean> {
    testMailbox.set(to.toLowerCase(), { subject, text, at: Date.now() });
    return true;
  },
};

export function providerFor(apiKey: string | null, from = "auth@example.com"): EmailProvider {
  return apiKey ? resendProvider(apiKey, from) : nullProvider;
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

/** The login-code email (code never logged). Returns true when Resend accepts. */
export async function sendLoginCode(
  provider: EmailProvider, to: string, code: string,
  idempotencyKey?: string,
): Promise<boolean> {
  return provider.send(
    to, "Your sign-in code",
    `Your code is ${code}. It expires in 3 minutes. If you did not request it, ignore this email.`,
    idempotencyKey ?? `login-code:${to}`,
  );
}

// --- Notification emails (spec §5.10). One stable idempotency key per event.
// Bodies never contain codes, phrases, tokens or full IPs.

export async function sendBackupUsed(
  provider: EmailProvider, to: string, remaining: number,
): Promise<void> {
  await provider.send(
    to, "A backup code was used",
    `One of your backup codes was just used to sign in. You have ${remaining} left. ` +
      `If this wasn't you, reset your authenticator now.`,
    `backup-used:${to}`,
  );
}

/** Permission change for the affected user (spec §5.10). */
export async function sendPermChange(
  provider: EmailProvider, to: string, perm: string, granted: boolean,
): Promise<void> {
  await provider.send(
    to, granted ? "A permission was granted" : "A permission was removed",
    `Your "${perm}" permission was ${granted ? "granted" : "removed"}.`,
    `perm:${to}:${perm}:${granted}`,
  );
}

/** Sign-in attempt from an unrecognized device (denied path, max 1 / 6 h). */
export async function sendDeniedAlert(
  provider: EmailProvider, to: string,
): Promise<void> {
  await provider.send(
    to, "Sign-in attempt on an unrecognized device",
    "Someone just tried to sign in to your admin account from a device we do not recognize. " +
      "No code was sent. If this wasn't you, no action is needed.",
    `denied-alert:${to}`,
  );
}

/** Sign-in from a new network (strict tier). No full IP, no UA beyond a hint. */
export async function sendNewNetwork(
  provider: EmailProvider, to: string, country: string | null,
): Promise<void> {
  await provider.send(
    to, "Sign-in from a new network",
    `Your admin account was just signed in from a new network` +
      `${country ? ` (${country})` : ""}. Extra checks are on for this session.`,
    `new-network:${to}`,
  );
}

/** A device was invited or registered (spec §5.10). */
export async function sendDeviceEvent(
  provider: EmailProvider, to: string, kind: "invited" | "registered",
): Promise<void> {
  await provider.send(
    to, kind === "invited" ? "A new device was invited" : "A new device was registered",
    kind === "invited"
      ? "A trusted-device invite was created for your admin account. It works once and expires in 15 minutes."
      : "A new trusted device was just registered for your admin account. If this wasn't you, revoke it now.",
    `device-${kind}:${to}`,
  );
}
