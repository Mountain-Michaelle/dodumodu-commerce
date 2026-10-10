// Auth secrets loaded from Worker secrets (base64). One place, fail-closed:
// a missing secret is a server fault (503), never a silent allow.
import { loadKey } from "./crypto";
import type { AuthEnv } from "./middleware";
import { AuthServerFaultError } from "./errors";

export interface AuthSecrets {
  otpKey: Uint8Array;
  throttleKey: Uint8Array;
  totpEncKey: Uint8Array;
  resendApiKey: string | null;
  turnstileSecret: string | null;
}

export function loadAuthSecrets(env: AuthEnv): AuthSecrets {
  const otpKey = env.OTP_KEY ? loadKey(env.OTP_KEY, "otp") : null;
  const throttleKey = env.THROTTLE_KEY ? loadKey(env.THROTTLE_KEY, "throttle") : null;
  const totpEncKey = env.TOTP_ENC_KEY ? loadKey(env.TOTP_ENC_KEY, "totp-enc") : null;
  if (!otpKey || !throttleKey || !totpEncKey) {
    // Missing secrets is OUR fault, not the caller's: fail closed as 503
    // {retry:true} (spec §4), never 401 and never a bare 500.
    throw new AuthServerFaultError("auth secrets not configured");
  }
  return {
    otpKey, throttleKey, totpEncKey,
    resendApiKey: env.RESEND_API_KEY ?? null,
    turnstileSecret: env.TURNSTILE_SECRET ?? null,
  };
}
