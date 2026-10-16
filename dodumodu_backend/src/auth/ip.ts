// IP handling for admin auth (spec §4.13). Deliberately SEPARATE from the
// visitor-analytics IP HMAC (ANALYTICS_IP_HMAC_SECRET): purpose-specific keys
// never share a secret. Nothing here stores or logs a raw IP — callers keep the
// normalized address only long enough to HMAC it (ip_hash) and, for the admin
// console, encrypt it (ip_enc). Pure functions; no I/O.
import { emailHmac, toHex } from "./crypto";

/** HMAC of a normalized IP with the dedicated IP_HMAC_KEY. This is ip_hash. */
export async function ipHash(ipHmacKey: Uint8Array, normalizedIp: string): Promise<string> {
  // Reuse the crypto HMAC with an "ip:" domain label so it can never collide
  // with the email HMAC even if the same key were (wrongly) supplied.
  return emailHmac(ipHmacKey, `ip:${normalizedIp}`);
}

/**
 * Normalize an IP string. Maps IPv4-mapped/compatible IPv6 to plain IPv4,
 * lowercases + zero-pads IPv6 to 8 groups. Returns null for anything that does
 * not parse (the caller routes null to an "unknown" bucket with a strict limit
 * rather than skipping the checks — spec §4.13).
 */
export function normalizeIp(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // IPv4 (also the v4 part of a mapped/compat v6).
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const oct = v4.slice(1).map((x) => Number(x));
    if (oct.some((n) => n > 255)) return null;
    return oct.join(".");
  }
  // IPv6, possibly with a trailing IPv4 (::ffff:1.2.3.4 or ::1.2.3.4).
  const lower = s.toLowerCase();
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) {
    const inner = normalizeIp(mapped[1]);
    return inner; // treat mapped/compatible addresses as their IPv4 form
  }
  if (!/^[0-9a-f:]+$/.test(lower) || lower.indexOf("::") !== lower.lastIndexOf("::")) return null;
  const [headStr, tailStr] = lower.split("::");
  const head = headStr ? headStr.split(":").filter(Boolean) : [];
  const tail = tailStr ? tailStr.split(":").filter(Boolean) : [];
  if (head.length + tail.length > 8) return null;
  for (const g of [...head, ...tail]) if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  const fill = 8 - head.length - tail.length;
  if (lower.indexOf("::") === -1 && fill !== 0) return null; // needs exactly 8 groups
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail];
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

/**
 * The block/throttle network: IPv4 at /32 (the whole address — a shared mobile
 * IP must be blocked as one unit, not per-host) and IPv6 at /64 (so rotating
 * inside a /64 cannot evade a block). Returns the normalized network string, or
 * null when the input did not parse.
 */
export function blockPrefix(raw: string): string | null {
  const ip = normalizeIp(raw);
  if (!ip) return null;
  if (ip.indexOf(":") === -1) return ip; // IPv4 /32
  return ip.split(":").slice(0, 4).join(":"); // IPv6 /64
}

export type TrustedProxy = "cloudflare" | "none" | { hops: number };

/**
 * Resolve the client IP from exactly one source selected by TRUSTED_PROXY.
 * Client-supplied forwarding headers are NEVER trusted unless they come from a
 * hop count you own. Returns the raw candidate string (normalizeIp/blockPrefix
 * validate it later); "0.0.0.0" when nothing trustworthy is present.
 */
export function clientIp(
  proxy: TrustedProxy,
  headers: { get(name: string): string | null },
  socketIp = "0.0.0.0",
): string {
  if (proxy === "cloudflare") {
    return headers.get("CF-Connecting-IP") ?? socketIp;
  }
  if (proxy === "none") {
    return socketIp;
  }
  const xff = headers.get("X-Forwarded-For");
  if (!xff) return socketIp;
  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
  const idx = parts.length - proxy.hops; // N-th from the right
  return idx >= 0 && idx < parts.length ? parts[idx] : socketIp;
}

/** Parse the TRUSTED_PROXY env value; unknown -> "none" (fail safe). */
export function parseTrustedProxy(raw: string | undefined): TrustedProxy {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "cloudflare") return "cloudflare";
  const m = /^hops:(\d+)$/.exec(v);
  if (m && Number(m[1]) >= 1) return { hops: Number(m[1]) };
  return "none";
}

export { toHex };
