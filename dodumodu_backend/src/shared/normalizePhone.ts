// MEASURED, and deliberately not optimised further.
//
// Shipping the Worker bundle with this import measures 980.8 KB uncompressed.
// That is roughly 191 KB more than the bundle without it (789.5 KB), and it is
// acceptable: the current Cloudflare Workers size limit is 64 MiB uncompressed on
// both Free and Paid plans. The older compressed 3 MB Free / 10 MB Paid figures
// were removed in September 2026.
//
// `/min` is kept rather than `/mobile` even though `/mobile` would be smaller.
// `/mobile` carries only mobile-number metadata, and that would bake a "mobile
// numbers only" assumption into a system whose job is correct canonical identity for
// every customer including international ones. That is the wrong thing to save
// bytes on. Revisit only if startup time is ever measured as a problem.
import parsePhoneNumber from "libphonenumber-js/min";

// ONE canonical phone representation for the whole application.
//
// This module exists because "who is this customer" must have exactly one
// answer. The abuse layer, the spam-flag table, the order history, the
// repeat-customer check and the ad-tracking hash all call THIS file. There is no
// second implementation anywhere - not in SQL, not in a generated column - so
// no two parts of the system can disagree about whether "+234 801 234 5678" and
// "08012345678" are the same person.
//
// WHY A LIBRARY RATHER THAN OUR OWN PARSER. This was hand-written first, and
// execution showed it wrong in four ways: it turned "+1 202 555 0123" into a
// Nigerian number (23412025550123), accepted "234801234567" as valid Nigerian
// despite having only nine national digits, and rejected the perfectly valid
// "002348012345678". Phone numbering plans are per-country, maintained metadata
// with real validity regexes; re-deriving that is exactly the kind of
// correctness-by-confidence that produces two identities for one customer.
// libphonenumber-js is that metadata in ~145 kB, server-side only.
//
// The canonical form is E.164 with a leading `+` (e.g. "+2348012345678"), and
// `null` means "this input is not a phone number we can identify". Callers must
// treat null as "no identity", never as "reject the customer": an unrecognised
// number is an observation, not a verdict.

/** Nigeria's calling code, used only to recognise a bare local number. */
const DEFAULT_COUNTRY = "NG";

/**
 * Canonicalize any phone input, or return null.
 *
 * `extract: true` is the important flag. Without it the library GUESSES a
 * country when the input carries no `+`, which is precisely the behaviour that
 * corrupts identity: a bare number would be silently attributed to some country
 * depending on its shape. With it, only an explicit `+` or the `defaultCountry`
 * fallback can resolve a number without an international prefix.
 *
 * `isValid()` rather than `isPossible()`: possible means "the length could be
 * right", valid means the country-specific pattern actually matches. Only valid
 * numbers become identities, so a truncated or invented number never becomes a
 * customer.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // "00234..." is valid international notation (the IDD prefix most of the world
  // outside North America uses), and libphonenumber-js does not strip it. Left
  // alone it parses the "0" as a trunk prefix and yields a NON-NONE identity -
  // "+23402348012345678" - which is a real number belonging to nobody and would
  // silently split one customer into two. So the IDD prefix is normalised to a
  // leading `+` before parsing.
  //
  // The lookahead requires a digit after "00" so a bare "0" or "00" is not
  // rewritten into "+".
  const withPlus = /^00(?=\d)/.test(trimmed) ? `+${trimmed.slice(2)}` : trimmed;

  let parsed;
  try {
    parsed = parsePhoneNumber(withPlus, { defaultCountry: DEFAULT_COUNTRY, extract: true });
  } catch {
    // The library throws on some pathological input rather than returning null.
    // An exception here must not become an exception in the order path.
    return null;
  }

  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

/**
 * The last 8 digits of a canonical number, as a SECONDARY lookup aid only.
 *
 * Why it exists: in an admin list, "08012345678" and "+2348012345678" are the
 * same customer written two ways, and an operator scanning for a number a
 * customer read aloud over the phone needs to find the order without retyping
 * international format.
 *
 * Why it is NOT an identity, and must never be treated as one:
 *  - eight digits are NOT guaranteed globally unique. Nigerian mobile ranges
 *    alone span far more than ten million numbers, and other countries' ranges
 *    overlap them entirely.
 *  - using it to BLOCK or to permanently flag would mean one customer's block
 *    silently applied to an unrelated person who happens to share a suffix.
 *
 * Therefore: temporary restrictions and spam flags are keyed on `phone_norm`
 * only. `phone_last8` is for search and disambiguation, never for restriction.
 */
export function phoneLast8(canonical: string | null | undefined): string | null {
  if (typeof canonical !== "string") return null;
  const digits = canonical.replace(/\D+/g, "");
  if (digits.length < 8) return null;
  return digits.slice(-8);
}

/** Nigeria's calling code, exported so logs and admin labels stay consistent. */
export const NIGERIA_CALLING_CODE = "+234";