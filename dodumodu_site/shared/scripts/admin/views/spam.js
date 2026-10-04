import { el, formatDateTime } from "../dom.js";
import { api } from "../api.js";
import { toast, toastError, openModal, definitionList } from "../ui.js";

// The spam-flagging pieces of the orders console.
//
// Design rules this file follows, all of them consequences of one fact: a flag is
// a PERMANENT exclusion of a person, made by a human.
//
//  - Nothing here is one click. Marking and reverting both go through a modal that
//    will not submit without a written reason. confirmDialog is deliberately NOT
//    used for this, because it gates on typing an exact phrase; what is wanted
//    here is free text that the SERVER then judges.
//
//  - The reason is never invented client-side. This file checks only that something
//    was typed, so the operator gets instant feedback. The real rule - length, and
//    refusing contentless reasons like "spam" - is server-side and authoritative,
//    and its message is shown as-is.
//
//  - The order list shows a BOOLEAN, never a reason. The reason belongs in the
//    detail view, where there is room to read it and act on it.
//
//  - Nothing here changes an order. The only endpoints this calls are the spam
//    flag, the revert, and the reads beside them.

/** Mirrors the server's own rule so the operator is told before a round trip. */
const MIN_REASON = 12;
const UNINFORMATIVE = ["spam", "spammer", "fraud", "fake", "scam", "test"];

/** The same check the service makes, so the Confirm button reflects reality. */
function reasonProblem(value) {
  const reason = (value || "").trim().replace(/\s+/g, " ");
  if (!reason) return "A reason is required.";
  if (UNINFORMATIVE.includes(reason.toLowerCase())) return "That does not explain anything - describe what you saw.";
  if (reason.length < MIN_REASON) return `At least ${MIN_REASON} characters, so this can be reviewed later.`;
  return null;
}

/**
 * Ask for a reason, returning it or null.
 *
 * Escape and outside-click close without saving; Enter does NOT submit, because a
 * stray newline in the text should never create a permanent record.
 */
function askForReason({ title, description, confirmLabel, danger }) {
  return new Promise((resolve) => {
    let textarea;
    let error;
    let confirmButton;

    const done = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    // Enter is captured only to stop the textarea submitting anything. There is no
    // form here, so this is belt-and-braces against a browser default.
    const onKey = (e) => {
      if (e.key === "Escape") done(null);
    };

    const validate = () => {
      const problem = reasonProblem(textarea.value);
      confirmButton.disabled = Boolean(problem);
      error.textContent = problem || "";
      return !problem;
    };

    textarea = el("textarea", {
      class: "input",
      rows: "4",
      placeholder: "For example: repeated fake orders using different phone numbers",
      oninput: validate,
    });
    error = el("p", { class: "field-error" });
    confirmButton = el("button", {
      class: danger ? "button button-danger" : "button button-primary",
      type: "button", text: confirmLabel, disabled: true,
      onclick: () => { if (validate()) done(textarea.value.trim().replace(/\s+/g, " ")); },
    });

    const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) done(null); } },
      el("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        el("h2", { class: "dialog-title", text: title }),
        el("div", { class: "dialog-body" },
          el("p", { text: description }),
          el("label", { class: "stack" }, el("span", { class: "muted", text: "Reason (required)" }), textarea),
          error),
        el("div", { class: "dialog-actions" },
          el("button", { class: "button", type: "button", text: "Cancel", onclick: () => done(null) }),
          confirmButton)));

    document.body.append(overlay);
    document.addEventListener("keydown", onKey);
    textarea.focus();
  });
}

/**
 * Mark an order's phone as spam.
 *
 * The flag is against the PHONE, not the order: every future order from that
 * number is refused, whichever operator places it. The modal says so, because that
 * is a bigger claim than the button's label implies.
 */
export async function markAsSpam(order, onDone) {
  const reason = await askForReason({
    title: "Mark as spam",
    description:
      `This blocks ${order.phone} from placing any further orders, and stays blocked until `
      + "someone reverts it. It does not change this order's status, payment or delivery.",
    confirmLabel: "Mark as spam",
    danger: true,
  });
  if (!reason) return false;

  try {
    await api.post("/spam/flag", { orderId: order.id, reason });
    toast("Flagged. This customer cannot order until the flag is reverted.", "success", 6000);
    onDone?.();
    return true;
  } catch (err) {
    // The server's message is the authority. Showing it verbatim is the point: the
    // browser check is a convenience and must never be the only guard.
    toastError(err);
    return false;
  }
}

/** Revert an active flag. Requires a reason too, for the same audit reason. */
export async function revertSpamFlag(flag, onDone) {
  const reason = await askForReason({
    title: "Revert spam flag",
    description:
      `${flag.phoneMasked} will be able to order again immediately. The flag stays in the `
      + "history, so this is recorded rather than undone.",
    confirmLabel: "Revert flag",
    danger: false,
  });
  if (!reason) return false;

  try {
    await api.post(`/spam/${flag.id}/revert`, { reason });
    toast("Flag reverted. This customer can order again.", "success");
    onDone?.();
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

/**
 * The spam panel inside the order detail modal.
 *
 * Returns null when there is no active flag, so an unflagged order shows no
 * section at all rather than an empty one.
 */
export function spamFlagSection(flag, onChanged) {
  if (!flag) return null;
  return el("div", { class: "detail-section spam-flag-panel" },
    el("h3", { class: "detail-heading", text: "Spam flag" }),
    el("p", { class: "muted", text: "This customer's phone is blocked from placing new orders. "
      + "The order above is unaffected - its status, payment and delivery are unchanged." }),
    definitionList([
      ["Status", "Active"],
      ["Phone", el("span", { class: "mono", text: flag.phoneMasked })],
      ["Reason", flag.reason],
      ["Flagged by", flag.flaggedBy],
      ["Flagged", formatDateTime(flag.flaggedAt)],
    ]),
    el("button", {
      class: "button button-small",
      type: "button",
      text: "Revert spam flag",
      onclick: () => revertSpamFlag(flag, onChanged),
    }));
}