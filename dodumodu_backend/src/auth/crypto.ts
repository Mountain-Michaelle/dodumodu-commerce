// WebCrypto-only helpers (run unchanged on Cloudflare Workers and Node 20+).
// No Buffer, no nodejs_compat. Verbatim from spec Appendix D, typed for TS.
const enc = new TextEncoder();
const ALPHABET = "0123456789ABCDEF!#$%&*+?";
export const CODE_LEN = 10;

export const toB64 = (u8: Uint8Array): string => {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
};
export const fromB64 = (s: string): Uint8Array => {
  if (typeof s !== "string" || !s) throw new Error("invalid base64");
  if (/[\s\u0000-\u001f\u007f]/.test(s)) throw new Error("invalid base64: whitespace is not allowed");
  if (!/^(?:[A-Za-z0-9+/]*={0,2}|[A-Za-z0-9_-]*={0,2})$/.test(s)) {
    throw new Error("invalid base64");
  }

  const firstPad = s.indexOf("=");
  const core = firstPad >= 0 ? s.slice(0, firstPad) : s;
  const providedPad = firstPad >= 0 ? s.slice(firstPad) : "";
  const remainder = core.length % 4;
  if (remainder === 1) throw new Error("invalid base64 length");
  const expectedPad = remainder === 0 ? 0 : 4 - remainder;
  if (providedPad && providedPad !== "=".repeat(expectedPad)) {
    throw new Error("invalid base64 padding");
  }

  const standard = core.replace(/-/g, "+").replace(/_/g, "/");
  let decoded: string;
  try {
    decoded = atob(standard + "=".repeat(expectedPad));
  } catch {
    throw new Error("invalid base64");
  }
  const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));

  if (toB64(bytes).replace(/=+$/, "") !== standard) {
    throw new Error("invalid base64 encoding");
  }
  return bytes;
};
export const b64u = (u8: Uint8Array): string =>
  toB64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function loadKey(b64: string, name = "key"): Uint8Array {
  const k = fromB64(b64);
  if (k.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return k;
}

// Local part: RFC 5322 dot-atom — allowed atoms separated by single dots, with
// no leading, trailing or consecutive dots. Lowercased already by the caller.
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// Domain label: alphanumeric, hyphens only in the middle, 1-63 chars.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Strict-ish email normalization used as the validity gate for admin auth.
 * Trim + lowercase, then require a real dot-atom local part and a dotted domain
 * whose labels are well-formed and whose TLD is at least two letters. Returns
 * null for anything that is not a plausible address (the caller treats null as
 * "unknown email", which is safe and non-enumerable on the login path).
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[\x21-\x7e]+$/.test(e)) return null; // ASCII printable only (no spaces/unicode)
  const at = e.indexOf("@");
  if (at <= 0 || at !== e.lastIndexOf("@") || at === e.length - 1) return null; // exactly one, not at an edge
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length > 64) return null;
  if (!LOCAL_RE.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null; // needs a dot (rejects "owner@example")
  for (const label of labels) {
    if (label.length < 1 || label.length > 63 || !LABEL_RE.test(label)) return null;
  }
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1])) return null; // TLD >= 2 letters
  return e;
}

export const maskEmail = (e: string): string => {
  const [l, d] = e.split("@");
  return `${l[0]}***@${d[0]}***`;
};

const hmacKey = (raw: Uint8Array) =>
  crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const hmac = async (raw: Uint8Array, msg: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(raw), enc.encode(msg)));

export const emailHmac = async (throttleKey: Uint8Array, normalizedEmail: string): Promise<string> =>
  b64u(await hmac(throttleKey, `email:${normalizedEmail}`));

export async function deriveCode(otpKey: Uint8Array, userId: string, nonce: Uint8Array): Promise<string> {
  let out = "",
    counter = 0;
  while (out.length < CODE_LEN) {
    const block = await hmac(otpKey, `code:${userId}:${b64u(nonce)}:${counter++}`);
    for (const b of block) {
      if (b < 240) {
        out += ALPHABET[b % 24];
        if (out.length === CODE_LEN) break;
      }
    }
  }
  return out;
}
export const codeMac = (otpKey: Uint8Array, userId: string, code: string): Promise<Uint8Array> =>
  hmac(otpKey, `mac:${userId}:${code}`);

export const randomToken = (): string => b64u(crypto.getRandomValues(new Uint8Array(32)));
export const sha256 = async (s: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const sha256Bytes = async (u8: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", u8 as BufferSource));

// AES-GCM for the TOTP secret at rest. key32 = 32 raw bytes from loadKey.
export async function encryptSecret(key32: Uint8Array, plain: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key32 as BufferSource, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, k, enc.encode(plain)),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return toB64(out);
}
export async function decryptSecret(key32: Uint8Array, blob: string): Promise<string> {
  const raw = fromB64(blob);
  const k = await crypto.subtle.importKey("raw", key32 as BufferSource, "AES-GCM", false, ["decrypt"]);
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, 12) as BufferSource },
      k,
      raw.subarray(12) as BufferSource,
    ),
  );
}

// TOTP (RFC 6238, SHA-1, 6 digits, 30 s). Returns the matched step so it can be replay-guarded in SQL.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const b32decode = (s: string): Uint8Array => {
  let bits = "";
  const out: number[] = [];
  for (const c of s.replace(/=+$/, "")) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
};
export const newTotpSecret = (): string => {
  const r = crypto.getRandomValues(new Uint8Array(20));
  let bits = "";
  for (const b of r) bits += b.toString(2).padStart(8, "0");
  let s = "";
  for (let i = 0; i < bits.length; i += 5) s += B32[parseInt(bits.slice(i, i + 5), 2)];
  return s;
};
export async function hotp(secretB32: string, counter: number, digits = 6): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    b32decode(secretB32) as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg as BufferSource));
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}
export async function totpMatch(
  secretB32: string,
  code: string,
  nowMs: number = Date.now(),
  window = 2,
): Promise<number | null> {
  const step = Math.floor(nowMs / 30000);
  for (let d = -window; d <= window; d++) if (safeEqual(await hotp(secretB32, step + d), code)) return step + d;
  return null;
}

// ---------------------------------------------------------------------------
// Hex helpers: the ONLY safe way to move a hash across the DB boundary.
//
// The migration stores every token/hash as bytea, but drizzle's raw `sql`
// binding sends parameters as text, so a Buffer/Uint8Array param fails with
// "invalid byte sequence for encoding UTF8: 0x00" on BOTH drivers (node-postgres
// binary protocol and neon-http JSON). Hex is plain ASCII, so it serialises
// identically everywhere. The rule: crypto returns bytes; toHex() at the edge;
// SQL uses decode($n,'hex') on input and encode(col,'hex') on output. Never
// bind a raw byte array. (Verified against local Postgres; see scripts note.)
// ---------------------------------------------------------------------------
export const toHex = (u8: Uint8Array): string => {
  let s = "";
  for (const b of u8) s += b.toString(16).padStart(2, "0");
  return s;
};
export const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};