import { el, mount, formatDateTime } from "../dom.js";
import { api } from "../api.js";
import { adminTable, listScaffold, errorState } from "../ui.js";

// The shadow report: what the automatic abuse system WOULD have done.
//
// WHY THIS SCREEN EXISTS. The abuse layer is in shadow mode, which means it counts
// and classifies but refuses nobody. Without somewhere to read that data the mode
// is indistinguishable from "off", and the honest question - "would this policy
// have blocked a real customer?" - cannot be answered without turning enforcement
// on and finding out the expensive way.
//
// WHAT IT DELIBERATELY DOES NOT SHOW. There is no risk score and no verdict. A
// single number would hide the thing that matters: a Nigerian carrier NAT and a
// fraudster can post IDENTICAL request volumes and differ completely on whether
// real orders came out of them. So every figure is shown beside the successful
// orders from the same address, and a row that looks alarming next to no successes
// is visually different from a busy row that has plenty.
//
// Nothing on this screen acts. It is read-only, and the manual spam workflow lives
// on the Orders screen where an operator has the order in front of them.

const WINDOWS = [
  { value: 3600, label: "Last hour" },
  { value: 24 * 3600, label: "Last 24 hours" },
  { value: 7 * 24 * 3600, label: "Last 7 days" },
  { value: 30 * 24 * 3600, label: "Last 30 days" },
];

export function shadowView({ shell }) {
  // listScaffold takes a HOST NODE and mounts its two halves into it; it returns
  // { controls, resultsNode, results(), load() } and no `root`. So the host is built
  // here, mounted into the shell in start(), and the scaffold is built against that
  // same host - which is the order orders.js uses.
  //
  // Getting this wrong is what made the screen blank: the previous version called
  // listScaffold on a detached div and then mounted `ui.root`, which does not exist,
  // so the panel silently contained nothing while the toolbar rendered normally.
  const host = el("div");
  const ui = listScaffold(host);
  let windowSeconds = 24 * 3600;
  let last = null;

  function windowSelect() {
    return el("select", {
      class: "input", id: "shadow-window",
      onchange: (e) => { windowSeconds = Number(e.target.value); load(); },
    }, WINDOWS.map((w) => el("option", {
      value: String(w.value), text: w.label, selected: w.value === windowSeconds,
    })));
  }

  async function load() {
    // The window picker lives in the page toolbar, which is where a filter belongs.
    // Rebuilt per load so its selected value survives a change.
    mount(shell.toolbar, el("div", { class: "list-toolbar" },
      el("label", { class: "field-inline", for: "shadow-window" },
        el("span", { class: "muted", text: "Window" }), windowSelect()),
      el("button", {
        class: "button button-small", type: "button", text: "Refresh", onclick: load,
      })));

    // Through the scaffold's own load(), which owns the busy state, the pending line
    // and the abort of a superseded request. Hand-rolling that here meant reaching
    // for `ui.results` - which is the FUNCTION that fills the panel, not the node,
    // so the screen threw before it drew anything. The node is `resultsNode`.
    try {
      const data = await ui.load((signal) => api.get(
        `/spam/shadow?windowSeconds=${windowSeconds}`, signal), { pending: "Loading observation data…" });
      // A request that lost its race returns null and must not render.
      if (!data) return;
      last = data;
      render();
    } catch (err) {
      ui.results(errorState(err, load));
    }
  }

  function stat(label, value, hint) {
    return el("div", { class: "stat" },
      el("span", { class: "stat-label", text: label }),
      el("span", { class: "stat-value", text: String(value) }),
      hint ? el("span", { class: "stat-hint", text: hint }) : null);
  }

  function render() {
    if (!last) return;
    const t = last.totals;

    ui.results(
      // The banner is the most important element on the page, so it comes first.
      el("div", { class: "notice notice-info" },
        el("p", { text: last.notice })),

      el("h3", { class: "detail-heading", text: "Activity" }),
      el("div", { class: "stat-row" },
        stat("Order requests seen", t.posts),
        stat("Distinct addresses", t.uniqueIps),
        stat("Distinct numbers", t.distinctPhones),
        stat("Failed attempts", t.validationFailures + t.turnstileFailures,
          `${t.validationFailures} invalid, ${t.turnstileFailures} challenge`),
        // Counter-evidence, given the same visual weight as the figures above it.
        stat("Successful orders", t.successfulProgressions, "disarms any block")),

      el("h3", { class: "detail-heading", text: "Orders by status" }),
      el("div", { class: "stat-row" },
        stat("Awaiting payment", t.ordersAwaitingPayment, "not suspicious"),
        stat("Confirmed COD", t.ordersConfirmedCod, "normal progression"),
        stat("Paid", t.ordersPaid, "money secured"),
        stat("Delivered", t.ordersDelivered, "completed"),
        stat("Failed", t.ordersFailed, "normal for a bad network"),
        stat("Unrecognised number", t.ordersUnidentifiable, "no identity claimed")),

      el("h3", { class: "detail-heading", text: "Addresses worth a look" }),
      el("p", { class: "muted", text:
        "An address is shared by many customers in Nigeria. High volume alone is not "
        + "evidence of anything - what separates a busy shared network from an "
        + "attacker is whether any real orders came out of it." }),
      (last.ips || []).length === 0
        ? el("p", { class: "muted", text: "No activity recorded in this window yet." })
        : adminTable({
          caption: "Activity by address",
          rows: last.ips,
          rowKey: (r) => r.ip,
          // A row with no successful orders is the only shape worth a second look,
          // and it is marked as needing review rather than labelled as abuse.
          rowClass: (r) => (r.successfulProgressions === 0 && r.posts >= 5 ? "is-review" : ""),
          columns: [
            { label: "Address", render: ({ row }) => el("span", { class: "mono", text: row.ip }) },
            { label: "Requests", className: "col-num", render: ({ row }) => String(row.posts) },
            { label: "Different numbers", className: "col-num", render: ({ row }) => String(row.distinctPhones) },
            { label: "Failed", className: "col-num", render: ({ row }) => String(row.validationFailures + row.turnstileFailures) },
            { label: "Successful orders", className: "col-num", render: ({ row }) => el("span", {
              class: row.successfulProgressions > 0 ? "badge badge-repeat" : "badge badge-duplicate",
              text: String(row.successfulProgressions),
              title: row.successfulProgressions > 0
                ? "Real orders came from this address - treat it as a customer, not a suspect"
                : "No successful orders yet",
            }) },
          ],
        }),

      (last.candidatesForReview || []).length > 0
        ? el("div", { class: "detail-section" },
          el("h3", { class: "detail-heading", text: "Worth a second look" }),
          el("p", { class: "muted", text: "Not a verdict. These are the shapes a person may want to see, with the context that would explain them either way." }),
          el("ul", { class: "evidence-list" }, last.candidatesForReview.map((c) => el("li", { class: "evidence-item" },
            el("div", { class: "stack" },
              el("span", { class: "mono", text: c.ip }),
              el("span", { class: "muted", text: `${c.posts} requests · ${c.distinctPhones} numbers · ${c.failures} failed · ${c.successfulProgressions} successful` })),
            el("p", { class: "muted", text: c.note })))))
        : null,

      (last.recentObservations || []).length > 0
        ? el("div", { class: "detail-section" },
          el("h3", { class: "detail-heading", text: "Recent decisions" }),
          adminTable({
            caption: "Recorded observations",
            rows: last.recentObservations,
            rowKey: (r, i) => `${r.createdAt}-${i}`,
            columns: [
              { label: "When", render: ({ row }) => formatDateTime(row.createdAt) },
              { label: "Number", render: ({ row }) => el("span", { class: "mono", text: row.phoneMasked || "—" }) },
              { label: "Outcome", render: ({ row }) => el("span", { class: "muted", text: row.outcome }) },
              { label: "Would have restricted", render: ({ row }) => el("span", {
                class: row.wouldRestrict ? "badge badge-duplicate" : "",
                text: row.wouldRestrict ? "Yes" : "No",
              }) },
              { label: "Reason", render: ({ row }) => el("span", { class: "muted", text: row.reason || "—" }) },
            ],
          }))
        : null,
    );
  }

  return {
    // start() is the shell's contract: the router calls it AFTER the shell has
    // cleared `content`, so this is the first moment it is safe to mount.
    start() {
      mount(shell.content, el("div", { class: "list-panel" },
        el("div", { class: "list-head" },
          el("h2", { class: "list-title", text: "What the checks would have done" }),
          el("span", { class: "muted", text: "Observed only. Nobody is blocked from this screen." })),
        host));
      return load();
    },
  };
}
