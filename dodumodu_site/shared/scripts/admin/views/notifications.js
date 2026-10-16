import { el, mount, formatDateTime } from "../dom.js";
import { v2api } from "../api.js";
import { statusBadge, toast, toastError, confirmDialog, errorState } from "../ui.js";
import { withStepUpRetry } from "../access.js";

// Notifications (every signed-in operator). Three attention queues in one
// screen: open lost-email requests, dead alert letters, live blocks.
// Admins can resolve/dismiss/lift (step-up); staff see the same queues
// read-only. Badge count = unread total from the same endpoint.

export function notificationsView({ shell }) {
  const host = el("div");

  async function load() {
    mount(host, el("div", { class: "table-state" },
      el("div", { class: "spinner", "aria-hidden": "true" }),
      el("p", { class: "muted", text: "Loading notifications…" })));
    try {
      const data = await v2api.get("/notifications");
      render(data);
    } catch (err) {
      mount(host, errorState(err, load));
    }
  }

  function render(data) {
    const reqs = data.openRequests || [];
    const dead = data.deadLetters || [];
    const live = data.liveBlocks || [];
    mount(host,
      el("div", { class: "list-panel" },
        el("div", { class: "list-head" },
          el("h2", { class: "list-title", text: "Needs attention" }),
          el("span", { class: "muted", text: `${data.unread || 0} open` })),
        el("div", { class: "panel-body stack" },
          el("h3", { class: "detail-heading", text: `Lost-email requests (${reqs.length})` }),
          reqs.length === 0
            ? el("p", { class: "muted", text: "No open requests." })
            : reqs.map((r) => el("div", { class: "notice-row" },
              el("div", { class: "stack" },
                el("span", { class: "strong", text: r.usernameAttempted }),
                el("span", { class: "muted", text: `Opened ${formatDateTime(r.createdAt)} — verify identity out-of-band before changing the email.` })),
              el("div", { class: "detail-actions" },
                el("button", { class: "button button-small", type: "button", text: "Dismiss", onclick: () => resolveReq(r.id, "dismissed", load) })))),
          el("h3", { class: "detail-heading", text: `Failed alerts (${dead.length})` }),
          dead.length === 0
            ? el("p", { class: "muted", text: "No failed deliveries." })
            : dead.map((d) => el("div", { class: "notice-row" },
              el("div", { class: "stack" },
                el("span", { class: "strong", text: d.kind }),
                el("span", { class: "muted", text: `${d.attempts} attempts — ${d.lastError || "no detail"}` })))),
          el("h3", { class: "detail-heading", text: `Live blocks (${live.length})` }),
          live.length === 0
            ? el("p", { class: "muted", text: "Nothing blocked." })
            : live.map((b) => el("div", { class: "notice-row" },
              el("div", { class: "stack" },
                el("span", {}, statusBadge("duplicate", b.kind), el("span", { class: "mono", text: ` ${b.blockRef}` }))),
              el("div", { class: "detail-actions" },
                el("button", { class: "button button-small", type: "button", text: "Lift", onclick: () => liftBlock(b.id, load) })))))));
  }

  async function resolveReq(id, action, reload) {
    if (!await confirmDialog({ title: `${action === "dismissed" ? "Dismiss" : "Resolve"} request?`, body: "The request leaves the open queue.", confirmLabel: "Confirm" })) return;
    try {
      await withStepUpRetry(() => v2api.post(`/account-requests/${id}/resolve`, { action }));
      toast("Request updated.", "success");
      reload();
    } catch (err) { toastError(err); }
  }

  async function liftBlock(id, reload) {
    if (!await confirmDialog({ title: "Lift this block?", body: "The device/IP can attempt sign-in again. Counters are not reset.", confirmLabel: "Lift block", danger: true })) return;
    try {
      await withStepUpRetry(() => v2api.del(`/blocks/${id}`));
      toast("Block lifted.", "success");
      reload();
    } catch (err) { toastError(err); }
  }

  return { start() { mount(shell.content, host); return load(); } };
}
