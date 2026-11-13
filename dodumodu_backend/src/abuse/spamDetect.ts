// The two rules, as pure functions of facts. No I/O here on purpose: every case that must never touch a real
// customer is a unit test on these, and the SQL that gathers the facts (holdRepo.ts) is tested separately.
import type { SpamConfig } from "./spamConfig";

/** What is known about ONE phone at the moment its order arrives. Counts exclude the order being judged. */
export interface PhoneFacts {
  /** Any earlier order of this phone was paid or delivered: a real customer, exempt from every spam rule. */
  trusted: boolean;
  /** Orders (stored + held) from this phone in the window. */
  prior: number;
  /** Of those, how many share this order's customer name OR delivery address. */
  similar: number;
  /** Of those, how many arrived inside the burst window. */
  burst: number;
}

export interface SpamDecision { spam: boolean; reason: string | null }

/**
 * Verified spam = an unproven phone that has ALREADY placed `phoneMax` orders in the window AND whose history
 * shows repetition (same name/address) or a rapid burst. A returning customer with delivered/paid history is
 * never evaluated; a new customer ordering several different things at an ordinary pace is not caught.
 */
export function decideSpam(f: PhoneFacts, cfg: SpamConfig): SpamDecision {
  if (f.trusted) return { spam: false, reason: null };
  if (f.prior < cfg.phoneMax) return { spam: false, reason: null };
  if (f.similar >= cfg.similarMin) {
    return { spam: true, reason: `${f.prior} orders from this phone in ${cfg.windowHours}h, ${f.similar} repeat the same name/address` };
  }
  if (f.burst >= cfg.burstMin) {
    return { spam: true, reason: `${f.prior} orders from this phone in ${cfg.windowHours}h, ${f.burst} within ${cfg.burstMinutes} minutes` };
  }
  return { spam: false, reason: null };
}

/** What is known about ONE device or address inside the RPF window. */
export interface SubjectFacts {
  /** Distinct phones that have NOT been paid/delivered before (a real shared network does not count against it). */
  untrustedPhones: number;
  orders: number;
}

export function decideRpf(scope: "ip" | "device", f: SubjectFacts, cfg: SpamConfig): boolean {
  if (cfg.rpfMode === "off") return false;
  return f.untrustedPhones >= (scope === "device" ? cfg.rpfDevicePhones : cfg.rpfIpPhones);
}

/** "Chrome 120 · Android" - a label for the operator, never the raw User-Agent. */
export function browserLabel(ua: string | null | undefined): string | null {
  if (typeof ua !== "string" || ua.length === 0) return null;
  const pick = (re: RegExp): string | null => { const m = re.exec(ua); return m ? m[1] : null; };
  let family: string | null = null;
  let v: string | null;
  if (/FBAN|FBAV/.test(ua)) family = "Facebook app";
  else if (/Instagram/i.test(ua)) family = "Instagram app";
  else if (/TikTok|BytedanceWebview/i.test(ua)) family = "TikTok app";
  else if ((v = pick(/EdgA?\/(\d+)/))) family = `Edge ${v}`;
  else if ((v = pick(/OPR\/(\d+)/))) family = `Opera ${v}`;
  else if ((v = pick(/SamsungBrowser\/(\d+)/))) family = `Samsung Internet ${v}`;
  else if ((v = pick(/(?:Firefox|FxiOS)\/(\d+)/))) family = `Firefox ${v}`;
  else if ((v = pick(/(?:Chrome|CriOS)\/(\d+)/))) family = `Chrome ${v}`;
  else if ((v = pick(/Version\/(\d+)[^ ]* .*Safari/))) family = `Safari ${v}`;
  else if (/curl|python|okhttp|axios|node|go-http|httpclient|wget|bot/i.test(ua)) family = "Script/HTTP client";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : null;
  const label = [family ?? "Unknown browser", os].filter(Boolean).join(" · ");
  return label.slice(0, 60);
}
