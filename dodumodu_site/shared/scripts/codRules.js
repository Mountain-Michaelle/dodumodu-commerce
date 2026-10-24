// Browser mirror of the server's COD gate (codPolicyService.ts +
// nigeriaStates.ts on the backend). It decides nothing: the order route always
// re-runs decideCod and answers 400 with the very same sentence. This module
// exists so the customer sees the disabled radio and the reason instead of
// discovering it on submit — and so the sentence they see first is the sentence
// they see second. Change the wording here and in codPolicyService.ts together;
// test/form-ux.check.mjs asserts the two still match.
const STATE_ALIASES = {
  abuja: "fct",
  "fct abuja": "fct",
  "f c t": "fct",
  "federal capital territory": "fct",
};
// "abuja state" dropped: normalizeState() strips " state" via /\s*state\b$/,
// so it collapses to "abuja" and maps through the entry above.

/** Same normalisation the backend applies: lowercase, punctuation dropped, aliases folded. */
export function normalizeState(value) {
  const collapsed = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*state\b$/, "")
    .trim();
  return STATE_ALIASES[collapsed] ?? collapsed;
}

export function isStateInList(state, list) {
  const wanted = normalizeState(state);
  if (!wanted) return false;
  return (list || []).some((entry) => normalizeState(entry) === wanted);
}

/**
 * The rules as the page received them. `null` means page-data never answered —
 * the page then says nothing about COD and lets the server be the only voice.
 * An empty `codStates` or a threshold of 0 is different: that is the server
 * actively refusing COD (the fail-closed default when the rules row is
 * missing), so the option is greyed out.
 */
export function parsePaymentRules(raw) {
  if (!raw || typeof raw !== "object") return null;
  const codStates = Array.isArray(raw.codStates)
    ? raw.codStates.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
    : [];
  const threshold = Number(raw.codBulkThreshold);
  return { codStates, codBulkThreshold: Number.isFinite(threshold) && threshold >= 0 ? Math.floor(threshold) : 0 };
}

function denied(reason, state, rules) {
  const message = reason === "state"
    ? `Pay on delivery isn't available in ${state || "your area"} yet — choose "Pay now" and we'll dispatch today.`
    : codBulkMessage(rules);
  return { allowed: false, reason, message };
}

/**
 * The threshold is the FIRST bulk quantity (5 means "5 or more pays now"), so
 * the sentence names threshold - 1 as what COD still covers. Kept as a helper
 * so decideCod and codHint can never print different ceilings.
 */
function codBulkMessage(rules) {
  const covered = rules.codBulkThreshold - 1;
  if (covered < 1) return `Pay on delivery isn't available for this quantity — choose "Pay now" to complete your order.`;
  return `Pay on delivery covers up to ${covered} ${covered === 1 ? "item" : "items"} — choose "Pay now" for bulk orders.`;
}

/** decideCod on the backend, minus the DB read. Check order matches it too. */
export function decideCod(state, quantity, rules) {
  if (!rules) return { allowed: true, reason: null, message: null, unknown: true };
  if (!isStateInList(state, rules.codStates)) return denied("state", state, rules);
  if (quantity >= rules.codBulkThreshold) return denied("bulk", state, rules);
  return { allowed: true, reason: null, message: null };
}

/**
 * The line under the payment radios. The allowed sentence names the same
 * ceiling the denial does (threshold - 1); both go through one helper so the
 * two can never print different numbers.
 */
export function codHint(state, quantity, rules) {
  if (!rules) return "";
  const decision = decideCod(state, quantity, rules);
  if (decision.allowed) {
    const covered = rules.codBulkThreshold - 1;
    return `Pay on delivery is available in your area for up to ${covered} ${covered === 1 ? "item" : "items"}.`;
  }
  return decision.message;
}
