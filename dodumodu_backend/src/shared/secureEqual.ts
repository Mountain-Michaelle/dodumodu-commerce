// One place for comparing a presented secret with the configured one.
//
//  * constant time with respect to the content (a mismatch does not return early);
//  * an empty or missing value on EITHER side never matches - otherwise an unset
//    secret and an absent header (undefined === undefined) would let anyone in;
//  * a configured value that is still a template placeholder is "not configured".
//
// Pure and dependency-free so it runs unchanged in the Worker and in Node.

const PLACEHOLDER = /^\s*(fill[-_ ]?in|change[-_ ]?me|replace[-_ ]?me|todo|xxx+|your[-_ ])/i;

/** True when the value looks like a real secret rather than blank or a template placeholder. */
export function isUsableSecret(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && !PLACEHOLDER.test(value);
}

/** Constant-time equality that is false whenever either side is empty or missing. */
export function secureEqual(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  if (presented.length === 0 || expected.length === 0) return false;
  const enc = new TextEncoder();
  const a = enc.encode(presented);
  const b = enc.encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** The check every shared-secret route makes: a usable configured secret AND a matching header. */
export function secretMatches(presented: string | null | undefined, configured: string | null | undefined): boolean {
  return isUsableSecret(configured) && secureEqual(presented, configured);
}
