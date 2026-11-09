// Throttle keys + token hashing. One module so every call site builds keys
// identically (spec §5.3, F2). Secrets never leave here as raw bytes.
//
// Email is always HMAC'd with THROTTLE_KEY before it enters a key
// (R-NOLOCK 1: locks bind email+IP or email+device, never email alone;
// audit logs carry only the HMAC, spec §4).
//
// Pair key:    "otp:<hmac(email)>:<ip>"
// Device key:  "otp:<hmac(email)>:dev:<device_id>"
// Strict key:  "otp:<hmac(email)>:dev:<device_id>:<prefix>"
// Fuse key:    "fuse:<hmac(email)>"
// Send caps:   "send:<hmac(email)>", "send:<hmac(email)>:<ip>"
import { emailHmac, sha256, toHex } from "./crypto";

/** HMAC(email) hex tag with THROTTLE_KEY. The ONLY email form that enters keys/logs. */
export async function emailTag(throttleKey: Uint8Array, normalizedEmail: string): Promise<string> {
  return emailHmac(throttleKey, normalizedEmail);
}

export const pairKey = (tag: string, ip: string): string => `otp:${tag}:${ip}`;
export const deviceKey = (stage: string, tag: string, deviceId: string): string =>
  `${stage}:${tag}:dev:${deviceId}`;
export const strictKey = (stage: string, tag: string, deviceId: string, prefix: string): string =>
  `${stage}:${tag}:dev:${deviceId}:${prefix}`;
export const fuseTag = (tag: string): string => `fuse:${tag}`;
export const sendEmailKey = (tag: string): string => `send:${tag}`;
/** Per-BROWSER send allowance (slot = the browser's vid, or the network for a cookie-less client). */
export const sendSlotKey = (tag: string, slot: string): string => `send:${tag}:slot:${slot}`;
/** Throttle bucket for a RECOGNIZED trusted browser: separate from the shared email+IP pair, so a stranger
 *  on the same network (NAT / mobile carrier) cannot spend or lock it. */
export const trustedPairKey = (tag: string, vidHash: string): string => `otp:${tag}:trusted:${vidHash.slice(0, 32)}`;
export const sendIpKey = (tag: string, ip: string): string => `send:${tag}:${ip}`;

/** SHA-256 hex of an opaque token (flow / session / device / invite / reset). */
export async function tokenHashHex(token: string): Promise<string> {
  return toHex(await sha256(token));
}
