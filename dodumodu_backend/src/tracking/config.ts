// Which ad platforms this deployment sends events to, and how.
//
// The rule this file exists to enforce: turning a platform ON or OFF, or changing
// a pixel id or an API version, is a CONFIG change and never a code change.
// Removing a platform from TRACKING_PLATFORMS must be possible without touching
// the dispatcher, an adapter, the order flow or the database — because the day
// one platform's API starts rejecting our traffic, the fix has to be possible
// without a deploy and without testing.
//
// Everything is read from a plain record of raw env values rather than from
// `Env` directly, so the whole resolution is unit-testable with any values at
// all, including none. That is the same convention src/config/imageConfig.ts uses.

/** The platform keys a registry entry may answer to. */
export type PlatformKey = string;

export type EventName = "page_view" | "view_content" | "initiate_checkout" | "purchase";

export type PlatformConfig = {
  key: PlatformKey;
  /** Non-secret. Copied onto every log row so one config can group per pixel. */
  pixelId: string;
  /** Secret. Lives in env only; never logged, never returned by any route. */
  accessToken: string;
  /** Kept in config rather than hardcoded, because these versions do change. */
  apiVersion: string;
  testEventCode: string | null;
  /**
   * How old an event may be when the platform will still accept it.
   *
   * Meta's Conversions API and TikTok's Events API both reject events outside a
   * window, and a pay-on-delivery confirmation can arrive days after the ad
   * click. Past this age we log `expired` rather than sending a conversion the
   * platform would reject anyway — a rejected event costs a retry and teaches us
   * nothing, while an `expired` row makes the gap visible.
   */
  maxEventAgeSeconds: number;
};

/**
 * Platform keys that were asked for, INCLUDING ones that did not resolve.
 *
 * This is not the same list as `platforms`: a key in TRACKING_PLATFORMS with no
 * adapter, or no config, still belongs here. The dispatcher reports it as a
 * `skipped` log row rather than dropping it silently, because "one platform
 * quietly stopped reporting" is the failure nobody notices until the ad account
 * has spent a month optimising against stale data.
 */
export type TrackingConfig = {
  enabled: boolean;
  /** Only the keys that resolved to a usable configuration. */
  platforms: Map<PlatformKey, PlatformConfig>;
  /** Every key asked for, including ones no adapter answered to. */
  requestedKeys: PlatformKey[];
  maxAttempts: number;
  currency: string;
  /** Pixels live in this mode until a real purchase proves them out. */
  testMode: boolean;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_CURRENCY = "NGN";

/**
 * Per-platform env prefix. A new platform is a new entry here and nothing else —
 * its keys are derived from its name rather than listed in a second place that
 * could fall out of step.
 */
function prefixFor(key: PlatformKey): string {
  return key.toUpperCase();
}

/**
 * Read a platform's own settings out of the raw env record.
 *
 * Returns null when the two settings that make the platform usable at all are
 * absent — pixel id and access token. A platform with half a configuration is
 * worse than an absent one, because it produces a row of failed events that look
 * like a real outage.
 */
function platformFrom(raw: Record<string, string | undefined>, key: PlatformKey): PlatformConfig | null {
  const p = prefixFor(key);
  const pixelId = (raw[`${p}_PIXEL_ID`] ?? "").trim();
  const accessToken = (raw[`${p}_ACCESS_TOKEN`] ?? "").trim();
  if (!pixelId || !accessToken) return null;

  const version = (raw[`${p}_API_VERSION`] ?? "").trim();
  const age = Number.parseInt(raw[`${p}_MAX_EVENT_AGE_SECONDS`] ?? "", 10);

  return {
    key,
    pixelId,
    accessToken,
    // Versions are configuration because the platforms change them; the defaults
    // here are the versions current at the time of writing, and setting the key
    // is how a future version moves without a code change.
    apiVersion: version || (key === "meta" ? "v21.0" : "v1.0"),
    testEventCode: (raw[`${p}_TEST_EVENT_CODE`] ?? "").trim() || null,
    maxEventAgeSeconds: Number.isFinite(age) && age > 0 ? age : 7 * 24 * 60 * 60,
  };
}

export function trackingConfigFrom(
  raw: Record<string, string | undefined> = {},
  resolve: (key: PlatformKey) => PlatformConfig | null = () => null,
): TrackingConfig {
  const requestedKeys = (raw.TRACKING_PLATFORMS ?? "meta,tiktok")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  const platforms = new Map<PlatformKey, PlatformConfig>();
  for (const key of requestedKeys) {
    const found = platformFrom(raw, key) ?? resolve(key);
    if (found) platforms.set(key, found);
  }

  const attempts = Number.parseInt(raw.TRACKING_MAX_ATTEMPTS ?? "", 10);

  return {
    // Tracking off unless somebody said on. A deployment that forgets to set the
    // flag sends nothing, which is the correct failure direction: a missing
    // config should never silently start advertising to third parties.
    enabled: raw.TRACKING_ENABLED === "true",
    platforms,
    requestedKeys,
    maxAttempts: Number.isFinite(attempts) && attempts > 0 ? attempts : DEFAULT_MAX_ATTEMPTS,
    currency: (raw.CURRENCY ?? "").trim() || DEFAULT_CURRENCY,
    testMode: raw.TRACKING_TEST_MODE === "true",
  };
}

