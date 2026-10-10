// Per-request auth context: ip/prefix/country/ua (spec §5.3) + the three
// __Host- cookies. Computed ONCE in middleware and reused everywhere.
//
// ip comes ONLY from CF-Connecting-IP — never X-Forwarded-For / X-Real-IP.
// For tests only, X-Test-IP may override ip when env.ALLOW_TEST_IP === "1"
// (that var exists only in .dev.vars; a test asserts it is absent from the
// deployed config).
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export interface ReqCtx {
  ip: string;
  prefix: string;
  country: string | null;
  ua: string;
}

/** IPv4 /24 as "a.b.c"; IPv6 /48 as the first three expanded hextets. */
export function ipPrefix(ip: string): string {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return dottedPrefix(mapped[1]);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return dottedPrefix(ip);
  // IPv6: expand "::" then take the first three hextets, lowercase.
  const halves = ip.split("::");
  let groups: string[] = [];
  if (halves.length === 1) {
    groups = ip.split(":").filter(Boolean);
  } else {
    const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
    const tail = halves[1] ? halves[1].split(":").filter(Boolean) : [];
    const fill = 8 - head.length - tail.length;
    groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail];
  }
  return groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, "").toLowerCase()).join(":");
}

function dottedPrefix(ip: string): string {
  const parts = ip.split(".");
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

/** Build the request context from the incoming request + CF hint. */
export function buildCtx(c: Context): ReqCtx {
  const env = c.env ?? {};
  let ip = c.req.header("CF-Connecting-IP") ?? "0.0.0.0";
  if (env.ALLOW_TEST_IP === "1") {
    const testIp = c.req.header("X-Test-IP");
    if (testIp) ip = testIp;
  }
  const country = (c.req.raw as Request & { cf?: { country?: string } }).cf?.country ?? null;
  const ua = (c.req.header("User-Agent") ?? "").slice(0, 120);
  return { ip, prefix: ipPrefix(ip), country, ua };
}

export const FLOW_COOKIE = "__Host-aaf";
export const SID_COOKIE = "__Host-sid";
export const DID_COOKIE = "__Host-did";

function hostCookie(c: Context, name: string, value: string, maxAge: number) {
  setCookie(c, name, value, {
    httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge,
  });
}

export function setFlowCookie(c: Context, token: string, ttlSecs: number) {
  hostCookie(c, FLOW_COOKIE, token, ttlSecs);
}
export function clearFlowCookie(c: Context) {
  setCookie(c, FLOW_COOKIE, "", { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 0 });
}
export function setSidCookie(c: Context, token: string, maxAge: number) {
  hostCookie(c, SID_COOKIE, token, maxAge);
}
export function setDidCookie(c: Context, token: string, maxAge: number) {
  hostCookie(c, DID_COOKIE, token, maxAge);
}
export function clearSidCookie(c: Context) {
  setCookie(c, SID_COOKIE, "", { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 0 });
}
export const getFlowToken = (c: Context): string | null => getCookie(c, FLOW_COOKIE) ?? null;
export const getSidToken = (c: Context): string | null => getCookie(c, SID_COOKIE) ?? null;
export const getDidToken = (c: Context): string | null => getCookie(c, DID_COOKIE) ?? null;
