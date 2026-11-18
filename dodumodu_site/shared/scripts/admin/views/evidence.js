import { el, formatDateTime } from "../dom.js";
import { api } from "../api.js";
import { toast, toastError, definitionList } from "../ui.js";
import { markAsSpam, revertSpamFlag } from "./spam.js";

// Order evidence in the admin console.
//
// FOUR BADGES, FOUR DIFFERENT MEANINGS, and the differences matter:
//
//   Reordering customer  - POSITIVE. This person bought before and the previous
//                          order was delivered. It is the single most reassuring
//                          thing on the row, and it is styled that way: green, not
//                          amber. Treating a repeat customer as suspicious is the
//                          mistake this badge exists to prevent.
//   Possible duplicate   - NEUTRAL. The same order - same phone, address, product and
//                          quantity - was submitted twice today. It
//                          may be an accidental double-tap, a second shop, or
//                          fraud. The badge never says which, and the panel says
//                          so in words.
//   Spam flagged          - the manual moderation state, shown by the existing tint.
//   Activity observed     - only when the address has enough activity to be worth
//                          looking at, and only in the DETAIL view.
//
// Nothing here decides anything. No badge changes an order, and none of them can
// block a customer - they are labels for a person making a decision.

const TONE = {
  repeat: "badge-repeat",
  duplicate: "badge-duplicate",
  spam: "badge-spam",
  activity: "badge-activity",
};

/**
 * The compact badges for a list row.
 *
 * Returns an empty fragment for an ordinary order, which is the point: a row with
 * nothing to say must look exactly like every other row, or the badges stop
 * meaning anything.
 */
export function orderBadges(order) {
  const badges = [];
  if (order.spamFlagged) {
    badges.push(el("span", { class: `badge ${TONE.spam}`, text: "Spam flagged" }));
  }
  // The bot check did not complete for this order (blocked script, slow phone, Cloudflare unreachable). It is a real
  // order; "pending" until the customer's page finishes the check, so worth a confirming message before shipping.
  if (order.botCheck === "failed") {
    badges.push(el("span", {
      class: `badge ${TONE.activity}`, text: "Bot check failed",
      title: "Cloudflare refused the token this order was sent with. The order is stored; confirm it with the customer before shipping.",
    }));
  }
  if (order.botCheck === "missing" || order.botCheck === "unverified") {
    badges.push(el("span", {
      class: `badge ${TONE.activity}`, text: "Bot check pending",
      title: order.botCheck === "missing" ? "No bot-check result arrived with this order" : "The bot check result could not be confirmed",
    }));
  }
  if (order.reordering) {
    badges.push(el("span", { class: `badge ${TONE.repeat}`, text: "Reordering customer" }));
  }
  // One badge for two sources: the read-time rule (same order submitted twice today) and the labels written when the order was
  // placed (a likely repeat of an open order, with the orders it resembles). The title names every related order.
  const labelled = (order.riskFlags || []).includes("probable_duplicate");
  if (order.possibleDuplicate || labelled) {
    const related = duplicateSummary(order);
    badges.push(el("span", {
      class: `badge ${TONE.duplicate}`,
      text: "Possible duplicate",
      title: related || (order.duplicateOf ? `The same order was submitted again today: ${order.duplicateOf.reference}` : "A matching order was placed today"),
    }));
  }
  if ((order.riskFlags || []).includes("unverified_burst")) {
    badges.push(el("span", {
      class: `badge ${TONE.activity}`, text: "Many unverified orders",
      title: "Several orders arrived from this connection in the last hour without a verified bot check. Shared mobile-network addresses are common, so review rather than assume.",
    }));
  }
  return el("span", { class: "badge-row" }, badges);
}

const DUPLICATE_REASONS = {
  same_number_within_minutes: "same number, minutes apart",
  same_number_and_name: "same number and name",
  same_number_and_address: "same number and address",
  same_name_and_address: "same name and address, different number",
};

/** "ddmd-ab12 (same number and name, 4 min apart); ..." or "" when this order has no stored references. */
export function duplicateSummary(order) {
  const refs = Array.isArray(order.duplicateRefs) ? order.duplicateRefs : [];
  return refs.map((r) => `${r.reference} (${DUPLICATE_REASONS[r.reason] || r.reason}, ${r.minutesApart} min apart)`).join("; ");
}

/**
 * The evidence section in the order detail.
 *
 * Returns null when there is nothing to say, so an ordinary order gets no empty
 * panel. Every heading states what it knows and, where the evidence is
 * inconclusive, says so rather than asserting a conclusion.
 */
export function orderEvidenceSection(data, { onChanged } = {}) {
  const evidence = data.evidence || {};
  const abuse = data.abuse;
  const spamFlag = data.spamFlag;
  const duplicateOf = evidence.duplicateOf;

  // An unrecognised number gets its own small line rather than silence. The panel
  // being empty would be indistinguishable from "this is a brand new customer",
  // which is the opposite of the truth and could mislead an operator.
  const unrecognised = evidence.phoneKnown === false;
  const hasCustomer = evidence.previousOrders > 0 || evidence.reordering;
  const hasAbuse = abuse && (abuse.posts > 1 || abuse.distinctPhones > 1);
  if (!hasCustomer && !hasAbuse && !duplicateOf && !spamFlag && !unrecognised) return null;

  return el("div", { class: "detail-section evidence-panel" },
    el("h3", { class: "detail-heading", text: "Customer activity" }),

    // ---- unrecognised number --------------------------------------------
    unrecognised ? el("div", { class: "evidence-block" },
      el("p", { class: "muted", text:
        "This phone number could not be recognised, so no customer history is claimed. "
        + "Nothing about this customer is being inferred from it." })) : null,
    // ---- customer history ------------------------------------------------
    hasCustomer ? el("div", { class: "evidence-block" },
      definitionList([
        ["Customer", evidence.reordering
          // Positive framing, deliberately: a repeat buyer is the good case.
          ? el("span", { class: "badge badge-repeat", text: "Reordering customer" })
          : "Has ordered before, but no previous order was delivered yet"],
        ["Previous orders", String(evidence.previousOrders)],
        ["Previous successful", `${evidence.previousSuccessful} paid or delivered`],
        evidence.lastOrderReference
          ? ["Last order", el("span", {},
            el("code", { class: "reference", text: evidence.lastOrderReference }),
            " ",
            el("span", { class: "muted", text: formatDateTime(evidence.lastOrderAt) }))]
          : null,
        // Stated explicitly rather than left to be inferred from an absent badge.
        evidence.phoneKnown === false
          ? ["Phone", el("span", { class: "muted", text: "Could not be recognised, so no customer history is claimed" })]
          : null,
      ].filter(Boolean))) : null,

    // ---- duplicate -------------------------------------------------------
    duplicateOf ? el("div", { class: "evidence-block" },
      el("h4", { class: "detail-subheading", text: "Possible duplicate" }),
      el("p", { class: "muted", text:
        "The same phone, delivery address, product and quantity were submitted again today. "
        + "This may be an accidental double submission, a second order from the same customer, "
        + "or something else. Nothing has been changed automatically." }),
      definitionList([
        ["Matching order", el("a", { href: "#", class: "reference-link", text: duplicateOf.reference,
          onclick: (e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("admin:open-order", { detail: duplicateOf.id })); } })],
        ["Placed", formatDateTime(duplicateOf.createdAt)],
      ])) : null,

    // ---- abuse observation ----------------------------------------------
    hasAbuse ? el("div", { class: "evidence-block" },
      el("h4", { class: "detail-subheading", text: "Activity observed from this address" }),
      el("p", { class: "muted", text:
        "An address is shared by many customers in Nigeria, so this is context and not an accusation. "
        + "Automatic blocking is currently switched off." }),
      definitionList([
        ["Address", el("span", { class: "mono", text: abuse.ipMasked })],
        ["Requests observed", String(abuse.posts)],
        ["Different numbers from this address", String(abuse.distinctPhones)],
        ["Failed attempts", String(abuse.failures)],
        ["Successful orders", el("span", { class: abuse.successfulProgressions > 0 ? "badge badge-repeat" : "", text: String(abuse.successfulProgressions) })],
      ])) : null,

    // ---- spam ------------------------------------------------------------
    spamFlag ? el("div", { class: "evidence-block" },
      el("h4", { class: "detail-subheading", text: "Spam flag" }),
      definitionList([
        ["Status", "Active"],
        ["Phone", el("span", { class: "mono", text: spamFlag.phoneMasked })],
        ["Reason", spamFlag.reason],
        ["Flagged by", spamFlag.flaggedBy],
        ["Flagged", formatDateTime(spamFlag.flaggedAt)],
      ]),
      el("button", {
        class: "button button-small", type: "button", text: "Revert spam flag",
        onclick: () => revertSpamFlag(spamFlag, onChanged),
      })) : null);
}