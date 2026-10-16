// Encrypted-IP storage for the admin auth log + blocks (spec §4.13 / C4).
//
// A raw IP is stored ONLY here, encrypted, and decrypted ONLY for admin display.
// Matching/throttling/keys use ip_hash (HMAC) instead — never this blob. Format:
//   v1:<kid>:<nonce_b64url>:<ciphertext+tag_b64url>
// A keyring maps kid -> 32-byte key so rotation is add-a-kid, deploy, re-encrypt
// in the background, retire when no row references the old kid. A decryption or
// integrity failure returns null (fail closed: "unavailable" in the console) and
// never throws into the request. AAD binds the blob to its purpose label.
import { toB64, fromB64 } from "./crypto";

const enc = new TextEncoder();
const PURPOSE = "aa-ip-enc-v1"; // AAD domain label

export type IpKeyring = Record<string, Uint8Array>;

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt a normalized IP under keyring[currentKid]. Fresh 96-bit nonce each call. */
export async function encryptIp(keyring: IpKeyring, currentKid: string, plainIp: string): Promise<string> {
  const key = keyring[currentKid];
  if (!key) throw new Error(`ip-enc key ${currentKid} missing`);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: enc.encode(PURPOSE) as BufferSource },
      await aesKey(key),
      enc.encode(plainIp),
    ),
  );
  return `v1:${currentKid}:${toB64(nonce)}:${toB64(ct)}`;
}

/** Decrypt an ip_enc blob. Accepts any kid in the keyring. null on any failure. */
export async function decryptIp(keyring: IpKeyring, blob: string): Promise<string | null> {
  try {
    const parts = blob.split(":");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    const [, kid, nonceB64, ctB64] = parts;
    const key = keyring[kid];
    if (!key) return null;
    const nonce = fromB64(padB64(nonceB64));
    const ct = fromB64(padB64(ctB64));
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: enc.encode(PURPOSE) as BufferSource },
      await aesKey(key),
      ct as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null; // tampered / wrong key / old retired kid -> unavailable, never crash
  }
}

/** b64u dropped its '=' padding; restore it before atob/fromB64. */
function padB64(s: string): string {
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}

export { toB64 };
