// Normalizing customer identifiers and hashing them, and nothing else.
//
// Two rules this file exists to enforce:
//
// 1. NORMALIZATION IS THE WHOLE POINT. A phone number typed as "0803 123 4567",
//    "+2348031234567" and "2348031234567" is the same customer, and an ad
//    platform matching on a hash only sees what we send. Hashing the raw string
//    would produce three digests for one person and quietly destroy match rate —
//    the exact metric that decides whether the algorithm finds more buyers like
//    them. So every string is reduced to ONE canonical form first, and only then
//    hashed. See normalizePhone below for the exact rules.
//
// 2. HASHING IS NOT ANONYMITY, and this file never pretends otherwise. These are
//    unsalted SHA-256 digests, which is what Meta and TikTok both specify, and it
//    is unsalted precisely so their systems can match. The consequence is that a
//    digest is a stable, re-identifiable handle for a phone number: anyone who has
//    both the digest and a phone book can confirm a guess. That is the platforms'
//    design, not a shortcut taken here, and it is why no raw phone number or email
//    is ever written to a tracking log. Nothing in this module writes anything —
//    it only computes strings.

import { createHash } from "node:crypto";
import { normalizePhone as normalizePhoneCanonical } from "../shared/normalizePhone";

// Two rules this file exists to enforce:
//
// 1. NORMALIZATION IS THE WHOLE POINT. A phone number typed as "0803 123 4567",
//    "+2348031234567" and "2348031234567" is the same customer, and an ad
//    platform matching on a hash only sees what we send. Hashing the raw string
//    would produce three digests for one person and quietly destroy match rate —
//    the exact metric that decides whether the algorithm finds more buyers like
//    them.
//
//    The RULES now live in ONE place, src/shared/normalizePhone.ts, because the
//    abuse layer, the spam-flag table and this module must all agree about who a
//    customer is. It used to be a second implementation living here, and two
//    implementations of "who is this person" is how a customer ends up with a
//    spam flag that does not match their own order history.
//
// 2. HASHING IS NOT ANONYMITY, and this file never pretends otherwise. These are
//    unsalted SHA-256 digests, which is what Meta and TikTok both specify, and it
//    is unsalted precisely so their systems can match. The consequence is that a
//    digest is a stable, re-identifiable handle for a phone number: anyone who has
//    both the digest and a phone book can confirm a guess. That is the platforms'
//    design, not a shortcut taken here, and it is why no raw phone number or email
//    is ever written to a tracking log. Nothing in this module writes anything —
//    it only computes strings.

export { normalizePhone } from "../shared/normalizePhone";

/**
 * The exact string the platforms are hashed against: canonical digits with NO
 * leading `+`.
 *
 * This is deliberately NOT the canonical form used everywhere else
 * ("+2348031234567"). The shared normalizer adopted E.164 for storage and
 * comparison, but the digest input predates it, and changing it would mean every
 * customer we have already sent to Meta suddenly had a NEW hash — splitting one
 * person's match history in two and degrading exactly the match rate this module
 * exists to protect.
 *
 * So the canonical identity decides WHO the customer is, and this decides what
 * bytes we hash. Both derive from the same normalizer, so they can never disagree
 * about who the customer is; they differ only in a character the platforms do not
 * hash on.
 */
function hashablePhone(canonical: string | null): string | null {
  return canonical === null ? null : canonical.replace(/\D+/g, "");
}

/**
 * Canonical email form: trimmed and lowercased.
 *
 * The two halves of an address are case-insensitive in practice — providers treat
 * `A@b.com` and `a@b.com` as one mailbox — so lowercasing the whole string is
 * what both platforms document. Returns null for anything without a plausible
 * `@`, because a value that cannot be an address must not become a digest that
 * silently never matches.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  // One @ only, no spaces, and something on both sides of the dot in the domain.
  if (trimmed.indexOf("@") !== at) return null;
  if (/\s/.test(trimmed)) return null;
  const domain = trimmed.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  return trimmed;
}

/**
 * SHA-256, lowercase hex — the digest form Meta and TikTok both expect.
 *
 * `node:crypto` rather than WebCrypto because this runs in both runtimes and the
 * sync form is what keeps the call sites free of `await` in hot paths. It is
 * imported as a side-effect-free named import so bundlers do not pull the whole
 * module in when a caller only wants `normalizePhone`.
 */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The full normalize-then-hash pair, returning null when the input is not
 * usable. This is the function call sites should use; the two halves are
 * exported separately so tests can pin normalization and hashing independently.
 */
export function hashPhone(raw: string | null | undefined): string | null {
  // hashablePhone, not normalizePhone: see its note. Hashing the canonical E.164
  // string including its "+" would produce a different digest from the one every
  // existing customer already has.
  const hashable = hashablePhone(normalizePhoneCanonical(raw));
  return hashable === null ? null : sha256(hashable);
}

export function hashEmail(raw: string | null | undefined): string | null {
  const normalized = normalizeEmail(raw);
  return normalized === null ? null : sha256(normalized);
}