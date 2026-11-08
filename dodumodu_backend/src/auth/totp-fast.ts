// Fast RFC 6238 matcher: one key import, parallel HMACs, constant-time compare.
import { b32decode } from "./crypto";

const STEP_MS = 30000;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function hotpWithKey(key: CryptoKey, counter: number, digits: number): Promise<string> {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg as BufferSource));
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}

/** Returns the matched step, or null. `window` = steps accepted on each side. */
export async function totpMatchFast(
  secretB32: string, code: string, nowMs: number = Date.now(), window = 2, digits = 6,
): Promise<number | null> {
  if (!/^\d+$/.test(code) || code.length !== digits) return null;
  const key = await crypto.subtle.importKey(
    "raw", b32decode(secretB32) as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const base = Math.floor(nowMs / STEP_MS);
  const steps = Array.from({ length: 2 * window + 1 }, (_, i) => base - window + i);
  const codes = await Promise.all(steps.map((s) => hotpWithKey(key, s, digits)));
  let hit: number | null = null;
  for (let i = 0; i < codes.length; i++) if (safeEqual(codes[i], code) && hit === null) hit = steps[i];
  return hit;
}