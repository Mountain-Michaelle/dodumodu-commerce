// Settings for the two order-abuse rules that never block a customer: spam HOLDS (one phone flooding) and
// rotating-phone-flood (RPF) ALERTS (many phones from one device/address). All of it is configuration; the rules
// themselves live in spamDetect.ts as pure functions.

export type SpamAction = "off" | "shadow" | "divert";
export type RpfMode = "off" | "alert";

export interface SpamConfig {
  action: SpamAction;
  /** Orders one phone may place inside the window before further ones count as spam. */
  phoneMax: number;
  windowHours: number;
  /** Prior orders (same phone, window) sharing this order's name or address needed as proof of repetition... */
  similarMin: number;
  /** ...or this many prior orders inside the burst window, whatever they say. */
  burstMin: number;
  burstMinutes: number;
  rpfMode: RpfMode;
  /** Distinct untrusted phones from ONE device / ONE address inside the RPF window. */
  rpfDevicePhones: number;
  rpfIpPhones: number;
  rpfWindowMinutes: number;
}

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw.trim() !== "" ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export function spamConfigFrom(raw: Record<string, string | undefined>): SpamConfig {
  const action: SpamAction = raw.RL_SPAM_ACTION === "divert" || raw.RL_SPAM_ACTION === "off" ? raw.RL_SPAM_ACTION : "shadow";
  return {
    action,
    phoneMax: int(raw.RL_SPAM_PHONE_MAX_24H, 5, 1, 500),
    windowHours: int(raw.RL_SPAM_WINDOW_HOURS, 24, 1, 168),
    similarMin: int(raw.RL_SPAM_SIMILAR_MIN, 3, 1, 100),
    burstMin: int(raw.RL_SPAM_BURST_MIN, 5, 1, 500),
    burstMinutes: int(raw.RL_SPAM_BURST_MINUTES, 15, 1, 1440),
    rpfMode: raw.RL_RPF_MODE === "off" ? "off" : "alert",
    rpfDevicePhones: int(raw.RL_RPF_DEVICE_PHONES, 4, 2, 500),
    rpfIpPhones: int(raw.RL_RPF_IP_PHONES, 6, 2, 500),
    rpfWindowMinutes: int(raw.RL_RPF_WINDOW_MINUTES, 60, 5, 10080),
  };
}

/** Valid addresses from a comma/semicolon/space separated list (max 5). */
export function emailList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 5);
}
