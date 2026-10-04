// Running the enabled adapters and recording what each one did.
//
// This is the boundary the whole module exists to hold. It runs on the path that
// confirms a customer paid, and its single most important property is NEGATIVE:
// nothing it does may change the HTTP response to OPay, alter an order's status,
// or throw into the caller. An ad platform being down, slow, or misconfigured is
// an advertising problem, never a payment problem.
//
// So every failure is caught here, recorded as a log row, and returned as data.
// The caller cannot accidentally await something that throws.

import type { NeutralEvent, FetchFn } from "./adapters/types";
import { adapterFor } from "./registry";
import type { TrackingConfig, PlatformConfig } from "./config";

/** What one platform's attempt resulted in. One log row per attempt outcome. */
export type DispatchOutcome = {
  platform: string;
  status: "sent" | "failed" | "skipped" | "expired";
  /** Null on success and on skips. Never contains a token. */
  error: string | null;
  /** Whether a later cron run should try again. */
  retryable: boolean;
};

/**
 * Is this event still inside the window the platform will accept?
 *
 * A pay-on-delivery confirmation can arrive days after the ad click, and both
 * platforms reject events outside their window. Sending one anyway costs a
 * request and teaches us nothing; recording `expired` makes the gap visible
 * instead of leaving a purchase that silently never arrives.
 */
export function isWithinWindow(
  event: NeutralEvent,
  config: PlatformConfig,
  now: Date = new Date(),
): boolean {
  const ageSeconds = (now.getTime() - new Date(event.eventTime).getTime()) / 1000;
  // A clock skewed slightly into the future is not a reason to discard a real
  // conversion; only events that are genuinely too OLD are refused.
  if (ageSeconds < 0) return true;
  return ageSeconds <= config.maxEventAgeSeconds;
}

/**
 * Send one neutral event to one platform, reporting rather than throwing.
 *
 * `fetchFn` is injected so this is testable with no network and no credentials.
 */
export async function dispatchTo(
  event: NeutralEvent,
  config: PlatformConfig,
  fetchFn: FetchFn,
  now: Date = new Date(),
): Promise<DispatchOutcome> {
  const adapter = adapterFor(config.key);
  if (!adapter) {
    // An unrecognised key in TRACKING_PLATFORMS. A typo must cost one platform,
    // never the order flow.
    return { platform: config.key, status: "skipped", error: "unknown_platform", retryable: false };
  }

  if (!isWithinWindow(event, config, now)) {
    return {
      platform: config.key,
      status: "expired",
      error: "past_platform_event_window",
      retryable: false,
    };
  }

  try {
    const result = await adapter.send(adapter.buildPayload(event, config), config, fetchFn);
    return {
      platform: config.key,
      status: result.ok ? "sent" : "failed",
      error: result.error,
      retryable: !result.ok && result.retryable,
    };
  } catch (error) {
    // buildPayload can throw on malformed input. The adapter contract says send
    // returns failures, but a bug here must still not reach the caller.
    return {
      platform: config.key,
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
      retryable: false,
    };
  }
}

/**
 * Send to every enabled platform, independently.
 *
 * One platform's failure cannot affect another's: each is awaited inside the same
 * try/catch discipline, and the loop keeps going. This is what makes Meta being
 * rate-limited invisible to TikTok, and it is tested directly rather than assumed.
 */
export async function dispatch(
  event: NeutralEvent,
  config: TrackingConfig,
  fetchFn: FetchFn,
  now: Date = new Date(),
): Promise<DispatchOutcome[]> {
  if (!config.enabled) return [];
  const outcomes: DispatchOutcome[] = [];
  for (const platformConfig of config.platforms.values()) {
    outcomes.push(await dispatchTo(event, platformConfig, fetchFn, now));
  }

  // A key that was asked for but never resolved still gets a row. Resolution
  // drops it from `platforms` because there is no usable config to send with,
  // and without this loop a typo in TRACKING_PLATFORMS would produce no evidence
  // at all - which is exactly the failure nobody notices until the ad account
  // has quietly gone a month without that platform's conversions.
  for (const key of config.requestedKeys) {
    if (!config.platforms.has(key) && !outcomes.some((o) => o.platform === key)) {
      outcomes.push({
        platform: key,
        // Distinguish "no such adapter" from "adapter exists, config missing":
        // the first means a typo, the second means a missing secret.
        error: adapterFor(key) ? "missing_config" : "unknown_platform",
        status: "skipped",
        retryable: false,
      });
    }
  }
  return outcomes;
}
