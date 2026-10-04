import { el, mount, formatDateTime } from "../dom.js";
import { api } from "../api.js";
import { toast, toastError, errorState, adminTable } from "../ui.js";

// The Blocked screen: who and what is currently being turned away, and why.
//
// TWO KINDS OF BLOCK LIVE HERE, and the distinction is the whole point of the screen:
//
//   MANUAL   - a person decided. Has a reason, a name against it, and lasts until
//              somebody releases it. This is the one that needs an operator's eye.
//   AUTOMATIC - a burst rule fired. Lasts ten minutes, expires on its own, and
//              carries the arithmetic that produced it so the decision can be
//              audited after the fact.
//
// They are shown separately and never mixed in one list. An automatic block in a
// table of manual ones would train an operator to ignore the rows that matter.
//
// WHAT THIS SCREEN CANNOT DO. There is no control here that blocks a phone number,
// because the schema does not allow it: a permanent decision about a person is the
// spam flag's job, on the Orders screen, and it requires a reason. An automatic
// burst block can only ever name an address or a device.

const DURATIONS = [
  { value: 600, label: "10 minutes (same as an automatic block)" },
  { value: 3600, label: "1 hour" },
  { value: 86400, label: "24 hours" },
  { value: null, label: "Until released (permanent)" },
];

function askForReason({ title, description, confirmLabel, danger, placeholder }) {
  return new Promise((resolve) => {
    let textarea, error, confirmButton;
    const done = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); done(null); }
    };
    const validate = () => {
      const reason = (textarea.value || "").trim().replace(/\s+/g, " ");
      // The server owns the real rule. This only stops an obviously-empty reason
      // from costing a round trip.
      const problem = reason.length < 12
        ? "At least 12 characters, so this can be reviewed later."
        : null;
      confirmButton.disabled = Boolean(problem);
      error.textContent = problem || "";
      return !problem;
    };

    textarea = el("textarea", {
      class: "input", rows: "4", placeholder, oninput: validate,
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
          el("label", { class: "stack" },
            el("span", { class: "muted", text: "Reason (required)" }), textarea),
          error),
        el("div", { class: "dialog-actions" },
          el("button", { class: "button", type: "button", text: "Cancel", onclick: () => done(null) }),
          confirmButton)));

    document.body.append(overlay);
    document.addEventListener("keydown", onKey);
    textarea.focus();
  });
}
/** Release a block. One click is not enough; a release is also a decision. */
export async function releaseBlock(block, onDone) {
  const reason = await askForReason({
    title: "Release this block",
    description: block.automatic
      ? "This was an automatic block. Releasing it ends the ten-minute window early and lets the "
        + "same address or device try again. The block stays in the history either way."
      : "This was a manual block. Releasing it lets the address or device order again, and the "
        + "block remains in the history with your name on the release.",
    confirmLabel: "Release",
    danger: false,
    placeholder: "For example: checked the orders behind this and they are genuine",
  });
  if (!reason) return false;
  try {
    await api.post(`/blocks/${block.id}/release`, { reason });
    toast("Released. The block stays in the history.", "success", 5000);
    onDone?.();
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

function blockTable(blocks, onRelease) {
  return adminTable({
    caption: "Blocked",
    rows: blocks,
    rowKey: (b) => b.id,
    columns: [
      { label: "Subject", render: ({ row }) => el("span", { class: "mono", text: row.value }) },
      { label: "Kind", render: ({ row }) => el("span", { class: "muted", text: row.automatic ? "device / address" : row.source }) },
      { label: "Reason", render: ({ row }) => el("span", { class: "muted", text: row.reason }) },
      {
        label: "How long",
        render: ({ row }) => (row.remainingSeconds === null
          ? el("span", { class: "muted", text: "until released" })
          : el("span", { text: `${Math.ceil(row.remainingSeconds / 60)} min left` })),
      },
      { label: "Since", render: ({ row }) => el("span", { class: "muted", text: formatDateTime(row.blockedAt) }) },
      {
        label: "",
        render: ({ row }) => el("button", {
          class: "button button-small", type: "button", text: "Release",
          onclick: () => onRelease(row),
        }),
      },
    ],
  });
}

export function blocksView({ shell }) {
  let host;

  async function load() {
    mount(host, el("div", { class: "list-panel" },
      el("div", { class: "list-head" }, el("div", { class: "spinner", "aria-hidden": "true" }))));
    try {
      const data = await api.get("/blocks");
      render(data);
    } catch (err) {
      mount(host, errorState(err, load));
    }
  }

  function render(data) {
    const manual = data.blocks.filter((b) => !b.automatic);
    const automatic = data.blocks.filter((b) => b.automatic);
    const onRelease = (block) => releaseBlock(block, load);

    mount(host,
      el("div", { class: "notice notice-info" }, el("p", { text: data.notice })),
      el("h3", { class: "detail-heading", text: `Blocked by a person (${manual.length})` }),
      manual.length === 0
        ? el("p", { class: "muted", text: "Nobody has been blocked by hand." })
        : blockTable(manual, onRelease),
      el("h3", { class: "detail-heading", text: `Blocked automatically (${automatic.length})` }),
      automatic.length === 0
        ? el("p", { class: "muted", text: "No burst rule has fired." })
        : el("div", {},
          el("p", { class: "muted", text: "A burst rule fired on these. Each expires on its own; "
            + "releasing one early just lets that subject try again sooner." }),
          blockTable(automatic, onRelease)),
      el("h3", { class: "detail-heading", text: "Block an address or device" }),
      el("p", { class: "muted", text: "To stop a customer's phone number being used, use "
        + "Mark as spam on the order instead. This screen is only for addresses and devices." }),
      addForm(load));
  }

  return {
    start() {
      host = el("div");
      mount(shell.content, host);
      return load();
    },
  };
}

/** The add-a-block form. Sits under the list rather than in a modal, because it is
 *  the routine action on this screen and a modal per block would be tiresome. */
function addForm(onDone) {
  const scope = el("select", { class: "input" },
    el("option", { value: "ip", text: "An address (IP)" }),
    el("option", { value: "device", text: "A device token" }));
  const value = el("input", { class: "input", type: "text", placeholder: "203.0.113.45" });
  const seconds = el("select", { class: "input" },
    DURATIONS.map((d) => el("option", {
      value: d.value === null ? "" : String(d.value), text: d.label,
    })));
  const reason = el("textarea", { class: "input", rows: "2", placeholder: "For example: confirmed bulk fake orders from this address" });
  const error = el("p", { class: "field-error" });

  const submit = el("button", { class: "button button-primary", type: "submit", text: "Block" });
  const form = el("form", {
    class: "stack",
    onsubmit: async (event) => {
      event.preventDefault();
      const text = reason.value.trim().replace(/\s+/g, " ");
      if (text.length < 12) {
        error.textContent = "At least 12 characters, so this can be reviewed later.";
        return;
      }
      error.textContent = "";
      submit.disabled = true;
      try {
        await api.post("/blocks", {
          scope: scope.value,
          value: value.value.trim(),
          reason: text,
          seconds: seconds.value === "" ? null : Number(seconds.value),
        });
        toast("Blocked.", "success");
        value.value = "";
        reason.value = "";
        onDone?.();
      } catch (err) {
        toastError(err);
      } finally {
        submit.disabled = false;
      }
    },
  },
    el("label", { class: "stack" }, el("span", { class: "muted", text: "What to block" }), scope),
    el("label", { class: "stack" }, el("span", { class: "muted", text: "Value" }), value),
    el("label", { class: "stack" }, el("span", { class: "muted", text: "For how long" }), seconds),
    el("label", { class: "stack" }, el("span", { class: "muted", text: "Reason (required)" }), reason),
    error,
    submit);

  return el("div", { class: "detail-section" }, form);
}