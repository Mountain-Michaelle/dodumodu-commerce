import { el, mount, formatDateTime } from "../dom.js";
import { v2api } from "../api.js";
import { statusBadge, toast, toastError, confirmDialog, errorState } from "../ui.js";
import { withStepUpRetry } from "../access.js";

export function notificationsView({ shell }) {
  const host = el("div");

  async function load() {
    mount(host, el("div", { class: "table-state" },
      el("div", { class: "spinner", "aria-hidden": "true" }),
      el("p", { class: "muted", text: "Loading notifications…" })));
    try {
      render(await v2api.get("/notifications"));
    } catch (err) {
      mount(host, errorState(err, load));
    }
  }

  function render(data) {
    const reqs = data.openRequests || [];
    const dead = data.deadLetters || [];
    const live = data.liveBlocks || [];
    const notifications = data.notifications || [];
    const notificationItems = notifications.length === 0
      ? [el("p", { class: "muted", text: "No notifications." })]
      : notifications.map((n) => el("div", { class: `notice-row notification-row${n.readAt ? " is-read" : " is-unread"}` },
        el("button", {
          class: "notification-link", type: "button",
          text: `${n.title}${n.body ? ` - ${n.body}` : ""}`,
          onclick: () => openNotification(n),
        }),
        el("div", { class: "notification-meta" },
          el("span", { class: "muted", text: formatDateTime(n.createdAt) }),
          n.readAt
            ? el("span", { class: "notification-read", text: "Read" })
            : el("button", { class: "button button-small", type: "button", text: "Mark read", onclick: () => markRead(n.id) }))));
    const requestItems = reqs.length === 0
      ? [el("p", { class: "muted", text: "No open requests." })]
      : reqs.map((r) => el("div", { class: "notice-row" },
        el("div", { class: "stack" },
          el("span", { class: "strong", text: r.usernameAttempted }),
          el("span", { class: "muted", text: `Opened ${formatDateTime(r.createdAt)} - verify identity out-of-band before changing the email.` })),
        el("div", { class: "detail-actions" },
          el("button", { class: "button button-small", type: "button", text: "Dismiss", onclick: () => resolveReq(r.id, "dismissed", load) }))));
    const deadItems = dead.length === 0
      ? [el("p", { class: "muted", text: "No failed deliveries." })]
      : dead.map((d) => el("div", { class: "notice-row" },
        el("div", { class: "stack" },
          el("span", { class: "strong", text: d.kind }),
          el("span", { class: "muted", text: `${d.attempts} attempts - ${d.lastError || "no detail"}` }))));
    const blockItems = live.length === 0
      ? [el("p", { class: "muted", text: "Nothing blocked." })]
      : live.map((b) => el("div", { class: "notice-row" },
        el("div", { class: "stack" },
          el("span", {}, statusBadge("duplicate", b.kind), el("span", { class: "mono", text: ` ${b.blockRef}` }))),
        el("div", { class: "detail-actions" },
          el("button", { class: "button button-small", type: "button", text: "Lift", onclick: () => liftBlock(b.id, load) }))));

    const body = el("div", { class: "panel-body stack" });
    body.append(
      el("h3", { class: "detail-heading", text: `Notifications (${notifications.length})` }),
      ...notificationItems,
      el("h3", { class: "detail-heading", text: `Lost-email requests (${reqs.length})` }),
      ...requestItems,
      el("h3", { class: "detail-heading", text: `Failed alerts (${dead.length})` }),
      ...deadItems,
      el("h3", { class: "detail-heading", text: `Live blocks (${live.length})` }),
      ...blockItems,
    );
    mount(host, el("div", { class: "list-panel" },
      el("div", { class: "list-head" },
        el("h2", { class: "list-title", text: "Needs attention" }),
        el("span", { class: "muted", text: `${data.unread || 0} open` }),
        notifications.some((n) => !n.readAt)
          ? el("button", { class: "button button-small", type: "button", text: "Mark all read", onclick: markAllRead })
          : null),
      body));
  }

  async function markRead(id) {
    try {
      await v2api.patch(`/notifications/${id}/read`, {});
      toast("Notification marked as read.", "success");
      load();
    } catch (err) { toastError(err); }
  }

  async function markAllRead() {
    try {
      await v2api.post("/notifications/read-all", {});
      toast("All notifications marked as read.", "success");
      load();
    } catch (err) { toastError(err); }
  }

  async function openNotification(notification) {
    if (!notification.readAt) {
      try { await v2api.patch(`/notifications/${notification.id}/read`, {}); } catch (err) { toastError(err); }
    }
    if (!notification.href) return load();
    const order = /^\/orders\/(\d+)/.exec(notification.href);
    if (order) {
      window.location.hash = `orders?order=${order[1]}`;
      return;
    }
    window.location.hash = notification.href.replace(/^\/+/, "");
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
