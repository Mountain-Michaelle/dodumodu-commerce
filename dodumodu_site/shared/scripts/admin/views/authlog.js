import { el, mount, formatDateTime } from "../dom.js";
import { v2api } from "../api.js";
import {
  adminTable, adminSearch, adminFilters, adminPagination, resultCount,
  statusBadge, errorState, listScaffold,
} from "../ui.js";

// Auth log (admin, authlog.view). Read-only timeline of every sign-in
// attempt, recovery, block, session and step-up event. Filters are
// server-side; decrypted IPs never leave the admin API.

const STATUS_BADGE = { success: "active", fail: "failed", blocked: "duplicate", locked: "duplicate", rate_limited: "not_picking", info: "paid" };

export function authlogView({ shell }) {
  const host = el("div");
  const ui = listScaffold(host);
  const state = { q: "", event: "", status: "", page: 1, pageSize: 20 };

  async function load() {
    const params = new URLSearchParams({
      q: state.q, event: state.event, status: state.status,
      limit: String(state.pageSize), offset: String((state.page - 1) * state.pageSize),
    });
    for (const [k, v] of [...params]) if (!v) params.delete(k);
    try {
      const data = await ui.load((signal) => v2api.get(`/auth-log?${params}`), { pending: "Loading auth log…" });
      if (data) render(data.rows || []);
    } catch (err) {
      mount(shell.content, el("div", { class: "list-panel" }, errorState(err, load)));
    }
  }

  function render(rows) {
    const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    mount(shell.toolbar,
      el("div", { class: "list-toolbar" },
        adminSearch({ value: state.q, placeholder: "Search event, user, reason…", onSearch: (v) => { state.q = v; state.page = 1; load(); } }),
        adminFilters({
          value: { status: state.status },
          filters: [{ key: "status", label: "Outcome", options: [
            { value: "", label: "All" }, { value: "success", label: "Success" },
            { value: "fail", label: "Failed" }, { value: "blocked", label: "Blocked" },
            { value: "locked", label: "Locked" }, { value: "rate_limited", label: "Rate limited" },
            { value: "info", label: "Info" },
          ] }],
          onChange: (next) => { state.status = next.status || ""; state.page = 1; load(); },
        })));
    ui.results(
      el("div", { class: "list-summary" }, resultCount({ page: { total: rows.length, totalPages: 1, page: 1, pageSize: rows.length || 1 }, noun: "event" })),
      adminTable({
        caption: "Auth log", rows, rowKey: (r) => r.id, empty: "No events match.",
        columns: [
          { label: "When", render: ({ row }) => el("span", { class: "nowrap", text: formatDateTime(row.at) }) },
          { label: "Event", render: ({ row }) => el("span", { class: "mono", text: row.event }) },
          { label: "Outcome", render: ({ row }) => statusBadge(STATUS_BADGE[row.status] || "inactive", row.status) },
          { label: "User", render: ({ row }) => el("span", { text: row.usernameAttempted || "—" }) },
          { label: "Device", render: ({ row }) => el("span", { class: "muted", text: row.deviceLabel || "—" }) },
          { label: "Detail", render: ({ row }) => el("span", { class: "muted", text: row.reason || row.stage || "—" }) },
        ],
      }));
  }

  return { start() { mount(shell.content, el("div", { class: "list-panel" }, host)); return load(); } };
}
