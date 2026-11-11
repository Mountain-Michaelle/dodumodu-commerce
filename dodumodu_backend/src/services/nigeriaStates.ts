// Nigerian state name normalisation, shared by the COD gate (codPolicyService)
// and the delivery-fee lookup (deliveryService).
//
// Both of those compare a customer-typed / dropdown value against a small
// configured list, and the cost of a mismatch is asymmetric and annoying:
// "abuja", "Abuja ", "Abuja State" and "FCT" are the same place, but a plain
// Set.has() call treats them as four different ones — the customer either gets
// a waybill fee they shouldn't, or loses pay-on-delivery they were entitled to.
//
// Comparison is always normalize(a) === normalize(b) — never normalize(a) alone —
// so whatever spelling an admin types into the rules table lands in the same
// space as what the customer picked.
const STATE_ALIASES: Record<string, string> = {
  // The FCT is sold as "Abuja" everywhere, but the state on a waybill is FCT.
  abuja: "fct",
  abiya: "fct",
  "f c t": "fct",
  "federal capital territory": "fct",
  // "X State" is how most Nigerians write the state out in full.
  "lagos state": "lagos",
  "ogun state": "ogun",
  "enugu state": "enugu",
  "abuja state": "fct",
  "fct abuja": "fct",
  "rivers state": "rivers",
  "kano state": "kano",
  "oyo state": "oyo",
};

/**
 * The 36 states plus the FCT, in the form they are stored.
 *
 * normalizeState alone is not validation: it folds aliases, so an input it does
 * not recognise simply passes through lowercased. That is correct for the COD
 * gate, which compares two spellings of a configured value and must not reject an
 * unfamiliar one. It is wrong for an admin edit, where "Atlantis" is a typo and
 * storing it produces an order that no "orders in <state>" filter can ever find -
 * a customer who cannot be located for delivery.
 */
const KNOWN_STATES = new Set([
  "abia", "adamawa", "akwa ibom", "anambra", "bauchi", "bayelsa", "benin", "borno",
  "cross river", "delta", "ebonyi", "edo", "ekun", "enugu", "fct", "gombe", "imo",
  "jigawa", "kaduna", "kano", "katsina", "kebbi", "kogi", "kwara", "lagos", "nasarawa",
  "niger", "ogun", "onyo", "osun", "oyo", "plateau", "rivers", "sokoto", "taraba",
  "yobe", "zamfara",
]);

/**
 * Is this one of the states we ship to? Used wherever a value is STORED for a
 * person to act on, as opposed to merely compared.
 */
export function isKnownState(value: string | null | undefined): boolean {
  return KNOWN_STATES.has(normalizeState(value));
}

export function normalizeState(value: string | null | undefined): string {
  const collapsed = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return STATE_ALIASES[collapsed] ?? collapsed;
}

/**
 * The display form of a state: "enugu" -> "Enugu".
 *
 * normalizeState is a COMPARISON helper and deliberately lowercases; what gets
 * stored is what a person is shown, so the two are separate functions. Keeping
 * them apart is what stops "FCT" (what a waybill says) and "Abuja" (what the
 * dropdown says) from being two different stored values for one place.
 */
export function displayState(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** True when two spellings refer to the same state. */
export function stateMatches(a: string, b: string): boolean {
  return normalizeState(a) === normalizeState(b);
}

/** True when `state` is one of `list`, ignoring spelling/case/"State" suffix. */
export function isStateInList(state: string, list: readonly string[]): boolean {
  const wanted = normalizeState(state);
  if (!wanted) return false;
  return list.some((entry) => normalizeState(entry) === wanted);
}

/** The states an operator may pick when entering an order by hand, in display form. */
export function knownStateNames(): string[] {
  return [...KNOWN_STATES].map(displayState).sort((a, b) => a.localeCompare(b));
}
