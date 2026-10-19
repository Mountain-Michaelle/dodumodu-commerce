import { el, mount, formatDateTime } from "../dom.js";
import { v2api } from "../api.js";
import {
  adminTable, adminSearch, adminFilters, adminPagination, resultCount,
  statusBadge, toastError, openModal, definitionList,
  errorState, listScaffold,
} from "../ui.js";
import { openMatrix, openEdit, openCreate, dangerOp } from "../access.js";

// Users & access (admin, users.view). LIST + DETAIL here; the access
// MATRIX + create/edit live in access.js (same screen, second file).

const ROLE_COPY = { admin: "Admin", mono: "Staff", general: "Mini admin" };
const roleBadge = (role) => statusBadge(
  role === "admin" ? "active" : role === "general" ? "paid" : "confirmed_cod",
  ROLE_COPY[role] || role);

export function usersView({ shell, identity }) {
  const host = el("div");
  const ui = listScaffold(host);
  const state = { q: "", role: "", active: "", page: 1, pageSize: 20 };
  const canManage = () => (identity?.v2perms || []).includes("users.manage")
    || (identity?.permissions || []).includes("users:write")
    || identity?.role === "admin";

  async function load() {
    const params = new URLSearchParams({
      q: state.q, role: state.role, active: state.active,
      limit: String(state.pageSize), offset: String((state.page - 1) * state.pageSize),
    });
    for (const [k, v] of [...params]) if (!v) params.delete(k);
    try {
      const data = await ui.load((signal) => v2api.get(`/users?${params}`), { pending: "Loading users…" });
      if (data) render(data);
    } catch (err) {
      ui.results(errorState(err, load));
    }
  }

  function render(data) {
    const users = data.users || [];
    const total = data.total ?? users.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    mount(shell.toolbar,
      el("div", { class: "list-toolbar" },
        adminSearch({ value: state.q, placeholder: "Search email or username…", onSearch: (v) => { state.q = v; state.page = 1; load(); } }),
        adminFilters({
          value: { role: state.role, active: state.active },
          filters: [
            { key: "role", label: "Role", options: [{ value: "", label: "All roles" }, { value: "admin", label: "Admin" }, { value: "mono", label: "Staff" }, { value: "general", label: "Mini admin" }] },
            { key: "active", label: "Status", options: [{ value: "", label: "All" }, { value: "true", label: "Active" }, { value: "false", label: "Inactive" }] },
          ],
          onChange: (next) => { state.role = next.role || ""; state.active = next.active || ""; state.page = 1; load(); },
        }),
        canManage() ? el("button", { class: "button button-primary button-small", type: "button", text: "+ Add user", style: "margin-left: auto", onclick: () => openCreate(load) }) : null));
    ui.results(
      el("div", { class: "list-summary" }, resultCount({ page: { total, totalPages: pages, page: state.page, pageSize: state.pageSize }, noun: "user" })),
      adminTable({
        caption: "Users", rows: users, rowKey: (r) => r.id,
        onRowClick: (row) => openDetail(row.id, load), empty: "No users match.",
        columns: [
          { label: "User", render: ({ row }) => el("div", { class: "stack" }, el("span", { class: "strong", text: row.username }), el("span", { class: "muted", text: row.email })) },
          { label: "Role", render: ({ row }) => roleBadge(row.role) },
          { label: "Status", render: ({ row }) => statusBadge(row.isActive ? "active" : "inactive", row.isActive ? "Active" : "Inactive") },
          { label: "Privileges", className: "col-num", render: ({ row }) => String(row.permCount ?? 0) },
          { label: "Last login", render: ({ row }) => el("span", { class: "nowrap", text: formatDateTime(row.lastLogin) }) },
        ],
      }),
      adminPagination({ page: state.page, totalPages: pages, onPage: (p) => { state.page = p; load(); } }));
  }

  return { start() { mount(shell.content, el("div", { class: "list-panel" }, host)); return load(); } };
}

async function openDetail(id, onDone) {
  let detail;
  try {
    detail = await v2api.get(`/users/${id}`);
  } catch (err) { toastError(err); return; }
  const { user, grants, history } = detail;
  const { close } = openModal({
    title: `${user.username} — ${user.email}`,
    render: () => el("div", { class: "stack" },
      definitionList([
        ["Role", ROLE_COPY[user.role] || user.role],
        ["Status", user.isActive ? "Active" : "Inactive"],
        ["Staff login", user.isStaff ? "Allowed" : "Blocked"],
        ["Enrolled", user.enrolled ? "Yes (TOTP set)" : "No — enrolls at first login"],
        ["Last login", formatDateTime(user.lastLogin)],
        ["Joined", formatDateTime(user.dateJoined)],
      ]),
      el("h3", { class: "detail-heading", text: `Privileges (${grants.length})` }),
      el("div", { class: "chip-row" }, grants.length ? grants.map((g) => el("span", { class: "chip", text: g })) : el("span", { class: "muted", text: "None granted." })),
      el("div", { class: "detail-actions" },
        el("button", { class: "button button-small", type: "button", text: "Edit access…", onclick: () => { close(); openMatrix(user, grants, onDone); } }),
        el("button", { class: "button button-small", type: "button", text: "Edit user…", onclick: () => { close(); openEdit(user, onDone); } }),
        el("button", { class: "button button-small button-danger", type: "button", text: "Deactivate", onclick: () => dangerOp("Deactivate user?", "Signed out everywhere; cannot sign in.", () => v2api.post(`/users/${id}/deactivate`, {}), close, onDone) })),
      history?.length ? el("div", {},
        el("h3", { class: "detail-heading", text: "Access history" }),
        adminTable({
          caption: "Access history", rows: history,
          columns: [
            { label: "When", render: ({ row }) => el("span", { class: "nowrap", text: formatDateTime(row.at) }) },
            { label: "Action", render: ({ row }) => el("span", { text: row.action }) },
            { label: "Outcome", render: ({ row }) => statusBadge(row.status === "success" ? "active" : "failed", row.status) },
          ],
        })) : null),
  });
}
