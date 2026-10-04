// The abuse layer's configuration.
//
// Every threshold is env-driven, and every default is chosen so that the DANGEROUS
// setting is the one nobody has to opt into:
//
//   - RL_MODE defaults to "shadow", so a deployment that sets no tracking of this
//     layer at all observes and never rejects. Enforcement has to be turned on by
//     a deliberate config edit, after real traffic has been measured.
//
//   - The automatic-restriction thresholds are set far ABOVE anything a genuine
//     customer, a shared carrier NAT, or a busy ad campaign could plausibly
//     produce. They are not "safe defaults" in the sense of being realistic; they
//     are placeholders deliberately beyond plausible traffic, because a threshold
//     nobody has measured is not trustworthy and the cost of it being wrong is a
//     lost customer.
//
// The window maths are pure and live in counters.ts; this file only decides what
// the numbers are, so that a threshold can change with a config edit and no code.

export type AbuseMode = "off" | "shadow" | "enforce";

/**
 * The automatic-block kill switch. Separate from `mode` on purpose: `mode` governs
 * the long-window volume rule, which can never refuse anyone, while this governs
 * the burst rules, which are the only thing in the system that can.
 */
export type AutoBlockMode = "off" | "shadow" | "on";

export type AbuseConfig = {
  mode: AbuseMode;
  /** Counting window. One fixed window shared by every signal. */
  windowSeconds: number;
  /** How long an established restriction would last, if enforcement were on. */
  blockSeconds: number;

  // ---- the automatic-restriction conjunction ----
  //
  // A temporary restriction requires ALL of these simultaneously. See
  // counters.ts/restrictionDecision for why each one is necessary and why none of
  // them is sufficient alone.

  /** Order POSTs from one IP in the window. */
  ipPosts: number;
  /** Distinct normalized phones from one IP in the window. */
  distinctPhones: number;
  /** Validation + Turnstile failures from one IP in the window. */
  failures: number;
  /**
   * The success interlock, and the most important number here.
   *
   * If an IP has at least this many orders that reached paid/delivered/confirmed_cod
   * in the window, it is treated as carrying real customers and CANNOT be
   * automatically restricted, however high the other signals climb.
   *
   * This is what makes a shared carrier NAT safe: a busy NAT's failure count is
   * high, but so is its successful-order count, and one of them disarms the other.
   */
  successFloor: number;

  /** Never limited. The owner's office, a test IP. */
  ipAllowlist: string[];

  /** Soft signals. These inform admin visibility ONLY and can never restrict. */
  softOpenOrdersPerPhone: number;
  softSuspectMinOrders: number;
  softSuspectWindowDays: number;

  // ---- burst protection ----
  //
  // Everything below describes a very SHORT window of committed orders. Nothing
  // here reads the long-window counters above, and nothing above reads these: the
  // two mechanisms share no table, no window and no code path, so a cumulative
  // count can never escalate into a refusal.

  /** off | shadow | on. The only switch that can refuse an order automatically. */
  autoBlock: AutoBlockMode;
  /** V2 stays shadow-only until this is on, independently of autoBlock. */
  v2Enabled: boolean;

  /** Burst window in seconds. Floored at 30 by abuseConfigFrom. */
  velocityWindowSeconds: number;

  /** V1, device-scoped. */
  v1MinOrders: number;
  v1MinPhones: number;

  /** V2, address-scoped, last resort. */
  v2MinOrders: number;
  v2MinPhones: number;
  /** Share of an address's burst orders that must sit on one device, or have none. */
  v2DeviceRatio: number;

  /** Automatic block duration. Always temporary; only manual blocks are permanent. */
  velocityBlockSeconds: number;

  /** Validated https WhatsApp host, or null when unset/unrecognised. */
  supportWhatsappUrl: string | null;
};

function int(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * A 0..1 proportion. Parsed rather than coerced, because `Number("abc")` is NaN
 * and NaN would silently compare false against every threshold - a misconfigured
 * ratio would quietly disable V2 instead of failing visibly.
 */
function ratio(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) return fallback;
  return value;
}

/**
 * The automatic-block kill switch.
 *
 * Three states, and the middle one is the point:
 *   off    - do not even evaluate a burst
 *   shadow - evaluate, LOG what would happen, refuse nobody   <- the default
 *   on     - refuse
 *
 * Anything unrecognised reads as shadow. That direction is deliberate: a typo in a
 * config value must never be the reason a real customer is turned away.
 */
function autoBlockMode(raw: string | undefined): AutoBlockMode {
  return raw === "on" || raw === "off" ? raw : "shadow";
}

/**
 * Only real WhatsApp hosts are accepted, and only over https.
 *
 * This string is rendered into a customer-facing error as a link, so it is
 * operator-controlled input that becomes an href. Accepting an arbitrary value
 * would put a `javascript:` or phishing URL into the hands of anyone who can
 * reach a config value. Anything unrecognised is dropped rather than escaped -
 * omitting the link is a better outcome than rendering a broken one.
 */
function whatsappUrl(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "wa.me" && parsed.hostname !== "api.whatsapp.com") return null;
  return parsed.toString();
}

/**
 * Resolve configuration from raw env values.
 *
 * Takes a plain record rather than Env so it is testable with any values at all,
 * including none — the same convention imageConfig.ts and tracking/config.ts use.
 */
export function abuseConfigFrom(raw: Record<string, string | undefined> = {}): AbuseConfig {
  const mode: AbuseMode =
    raw.RL_MODE === "enforce" || raw.RL_MODE === "off" ? raw.RL_MODE : "shadow";
  const autoBlock = autoBlockMode(raw.RL_AUTO_BLOCK);

  return {
    mode,
    windowSeconds: int(raw.RL_WINDOW_SECONDS, 900),
    blockSeconds: int(raw.RL_BLOCK_SECONDS, 1800),

    // Deliberately far above plausible real traffic. A shared Nigerian carrier
    // NAT concentrates many real customers behind one address, and an ad campaign
    // can legitimately produce a burst of orders from one IP in fifteen minutes.
    // These numbers are meant to be REPLACED by measurements from shadow mode, not
    // trusted as-is. See the shadow report before changing RL_MODE.
    ipPosts: int(raw.RL_ABUSE_IP_POSTS, 120),
    distinctPhones: int(raw.RL_ABUSE_DISTINCT_PHONES, 40),
    failures: int(raw.RL_ABUSE_FAILURES, 60),
    successFloor: int(raw.RL_ABUSE_SUCCESS_FLOOR, 3),

    ipAllowlist: (raw.RL_IP_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),

    // ---- burst protection: the only automatic refusal in the system ----
    //
    // Deliberately SEPARATE from every threshold above. Those describe sustained
    // volume across a fifteen-minute window and may never refuse anyone: they feed
    // the shadow report and the Suspects list, and a person decides. The burst
    // rules below describe what arrived inside SECONDS, and are the only path that
    // can turn an order away - and only when autoBlock is "on".
    autoBlock,
    v2Enabled: raw.RL_V2_ENABLED === "on",

    // Clamped to a floor. A burst window is a claim about how fast a person can
    // act, and below roughly half a minute that claim stops being honest: a burst
    // becomes indistinguishable from an impatient customer.
    velocityWindowSeconds: Math.max(30, int(raw.RL_VELOCITY_WINDOW_SECONDS, 60)),

    // V1, device-scoped: several identities on ONE device inside the window.
    v1MinOrders: int(raw.RL_V1_MIN_ORDERS, 4),
    v1MinPhones: int(raw.RL_V1_MIN_PHONES, 3),

    // V2, address-scoped, last resort. Deliberately more demanding than V1, and
    // separately gated by v2Enabled. Spreading across devices defeats V1 and this
    // is the rule that notices - at the cost of being the one most likely to be
    // wrong, because a busy address is indistinguishable from a bot by volume
    // alone. The concentration test is what separates them.
    v2MinOrders: int(raw.RL_V2_MIN_ORDERS, 10),
    v2MinPhones: int(raw.RL_V2_MIN_PHONES, 4),
    v2DeviceRatio: ratio(raw.RL_V2_DEVICE_RATIO, 0.7),

    // Ten minutes. Automatic blocks are ALWAYS temporary: a burst is evidence about
    // a moment, and an address that misbehaved at 14:00 may be a shared office
    // network at 14:10. Only a manual block may be permanent.
    velocityBlockSeconds: int(raw.RL_VELOCITY_BLOCK_SECONDS, 600),

    // null when unset or not a recognised WhatsApp host. The 429 omits the link
    // rather than rendering a broken or untrusted one.
    supportWhatsappUrl: whatsappUrl(raw.SUPPORT_WHATSAPP_URL),

    softOpenOrdersPerPhone: int(raw.RL_PHONE_MAX_OPEN, 3),
    softSuspectMinOrders: int(raw.SUSPECT_MIN_ORDERS, 5),
    softSuspectWindowDays: int(raw.SUSPECT_WINDOW_DAYS, 30),
  };
}
