"use strict";

const UI = window.AdminUI;
const $ = UI.$;
const BASE = UI.BASE;
const USERS_API = `${BASE}/admin-v2/users`;

function note(kind, text) {
  const el = $("note");
  el.className = "note " + kind;
  el.textContent = text;
  el.hidden = !text;
}

function panelNote(panel, kind, text) {
  const el = $(panel + "-note");
  if (!el) return;
  el.className = "note " + kind;
  el.textContent = text;
  el.hidden = !text;
}

async function stepUp(action) {
  let response = await action();
  if (!response || response.status !== 403) return response;
  const code = prompt("Re-enter your authenticator code:");
  if (!code) return response;
  const step = await fetch(`${BASE}/auth/stepup`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return step.ok ? action() : step;
}

let users = [];
let registry = [];

// Selected-user security state (sessions/devices panels).
let selectedUserId = null;
let selectedUserEmail = null;
let sessionsRequestId = 0;
let devicesRequestId = 0;

function errorMessage(response) {
  return response.status === 403 ? "Fresh administrator verification is required." : "The operation could not be completed.";
}

function shortSid(sid) {
  if (!sid) return "—";
  const s = String(sid);
  return s.length > 8 ? s.slice(0, 4) + "…" + s.slice(-4) : s;
}

function userCell(user) {
  const wrap = document.createElement("div");
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "";
  if (name) { const n = UI.el("div", "cell-main", name); n.title = name; wrap.appendChild(n); }
  wrap.appendChild(UI.copyLine(user.email, "email", name ? "cell-sub" : "cell-main"));
  wrap.appendChild(UI.copyLine(user.id, "user ID", "mono"));
  return wrap;
}

function rowFor(user) {
  const row = UI.el("div", "row"); row.setAttribute("role", "row");
  row.appendChild(UI.cell("User", userCell(user)));

  const role = document.createElement("select");
  role.setAttribute("aria-label", `Role for ${user.email}`);
  const values = ["admin", "general", "mono"];
  if (!values.includes(user.role)) values.push(user.role);           // never show a wrong role for a legacy value
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value; option.textContent = value; option.selected = user.role === value;
    role.appendChild(option);
  }
  role.addEventListener("change", async () => {
    role.disabled = true;
    const response = await stepUp(() => fetch(`${USERS_API}/${encodeURIComponent(user.id)}`, {
      method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: role.value }),
    }));
    if (response.ok) { note("ok", "Role updated."); load(); }
    else { role.disabled = false; role.value = user.role; note("error", errorMessage(response)); }
  });
  row.appendChild(UI.cell("Role", role));
  row.appendChild(UI.cell("Status", UI.badge(user.isActive ? "Active" : "Inactive", user.isActive ? "ok" : "bad")));
  row.appendChild(UI.cell("Authenticator", UI.badge(user.enrolled ? "Enrolled" : "Pending", user.enrolled ? "ok" : "warn")));

  const actions = UI.el("div", "cell cell-actions right");
  actions.style.flexWrap = "wrap";
  const add = (label, cls, handler) => {
    const b = UI.el("button", cls + " btn-sm", label); b.type = "button";
    b.addEventListener("click", () => UI.busy(b, () => handler(b))); actions.appendChild(b); return b;
  };
  if (user.role !== "admin") add("Permissions", "btn-ghost", async () => openAccess(user));
  add("Sessions", "btn-ghost", async () => openSessions(user));
  add("Devices", "btn-ghost", async () => openDevices(user));
  if (user.role === "admin") add("Add device", "btn-ghost", async () => inviteFor(user));
  add(user.isActive ? "Deactivate" : "Activate", user.isActive ? "btn-danger" : "btn-ghost", async () => {
    if (user.isActive && !confirm(`Deactivate ${user.email}? They will be signed out and cannot sign in.`)) return;
    const response = await stepUp(() => fetch(`${USERS_API}/${encodeURIComponent(user.id)}`, {
      method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !user.isActive }),
    }));
    if (response.ok) { note("ok", "User updated."); load(); } else note("error", errorMessage(response));
  });
  row.appendChild(actions);
  return row;
}

// Server-side search + paging: the list is never trimmed to what happens to be loaded.
const view = { q: "", role: "", offset: 0, limit: 25, total: 0, reqId: 0 };

async function load() {
  const my = ++view.reqId, list = $("list");
  if (!list.children.length) list.replaceChildren(UI.stateBox("", "Loading…"));
  const p = new URLSearchParams({ limit: String(view.limit), offset: String(view.offset) });
  if (view.q) p.set("q", view.q);
  if (view.role) p.set("role", view.role);
  const response = await UI.api(`/admin-v2/users?${p}`);
  if (my !== view.reqId) return;
  if (!response) { list.replaceChildren(UI.stateBox("error", "Could not reach the server. Check your connection.")); return; }
  if (response.status === 403) { list.replaceChildren(UI.stateBox("error", "You do not have permission to view users.")); $("pager").hidden = true; return; }
  if (!response.ok) { list.replaceChildren(UI.stateBox("error", "Could not load users.")); return; }
  const data = await response.json();
  users = Array.isArray(data.users) ? data.users : [];
  view.total = Number(data.total) || 0;
  $("count").textContent = `${view.total} user${view.total === 1 ? "" : "s"}`;
  if (users.length === 0 && view.offset > 0) { view.offset = 0; return load(); }   // page vanished (deletes/filters)
  list.replaceChildren(...(users.length ? users.map(rowFor)
    : [UI.stateBox("", view.q || view.role ? "No users match your search." : "No users yet.")]));
  UI.renderPager($("pager"), view, (o) => { view.offset = o; load(); });
}

/** Single-use link that lets ANOTHER administrator add a new browser (bound to that user on the server). */
async function inviteFor(user) {
  const res = await stepUp(() => UI.api(`/admin-v2/users/${encodeURIComponent(user.id)}/device-invite`, { method: "POST" }));
  const box = $("user-invite-box");
  if (!res || !res.ok) {
    note("error", res && res.status === 403 ? "Fresh administrator verification is required." : res && res.status === 429 ? "Too many invites. Try again later." : "Could not create an invite for that user.");
    return;
  }
  const { invite_url } = await res.json();
  box.replaceChildren(UI.el("div", "small", `Send this single-use link to ${user.email} (expires in 15 minutes). Whoever opens it first can add a device for that account:`));
  const line = UI.el("div", "invite-line"); const a = UI.el("a", "", invite_url); a.href = invite_url; a.rel = "noopener noreferrer";
  line.append(a, UI.copyButton(invite_url, "invite link")); box.appendChild(line); box.hidden = false;
  note("", "");
}

async function loadRegistry() {
  const response = await fetch(`${USERS_API.replace(/\/users$/, "")}/permissions/registry`, { credentials: "same-origin" });
  if (response.ok) {
    const data = await response.json();
    registry = data.permissions || data.registry || [];
  } else {
    registry = [];
    note("error", "Could not load the permission registry.");
  }
}

async function openAccess(user) {
  const detailResponse = await fetch(`${USERS_API}/${encodeURIComponent(user.id)}`, { credentials: "same-origin" });
  if (!detailResponse.ok) { note("error", "Could not load that user's permissions."); return; }
  const detail = await detailResponse.json();
  $("access-panel").hidden = false;
  $("access-user").textContent = `${user.email} — ${user.role}`;
  $("access-panel").dataset.userId = user.id;
  $("access-panel").dataset.role = user.role;
  const grants = new Set(detail.grants || []);
  const eligible = registry.filter((entry) => !entry.adminOnly && (entry.roles || []).includes(user.role));
  const list = $("permission-list");
  list.replaceChildren();
  const groups = new Map();
  for (const entry of eligible) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  for (const [group, entries] of groups) {
    const heading = document.createElement("h3");
    heading.textContent = group;
    list.appendChild(heading);
    for (const entry of entries) {
      const label = document.createElement("label");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.name = "permission";
      check.value = entry.key;
      check.checked = grants.has(entry.key);
      label.append(check, document.createTextNode(` ${entry.label}`));
      list.appendChild(label);
    }
  }
}

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("create-user");
  button.disabled = true;
  const email = $("create-email").value.trim();
  const role = $("create-role").value;
  const response = await stepUp(() => fetch(USERS_API, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  }));
  button.disabled = false;
  if (response.ok) { note("ok", "User created."); load(); }
  else note("error", errorMessage(response));
});

$("access-close").addEventListener("click", () => { $("access-panel").hidden = true; });
$("access-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const panel = $("access-panel");
  const perms = [...$("permission-list").querySelectorAll("input[name='permission']:checked")]
    .map((input) => input.value);
  const response = await stepUp(() => fetch(`${USERS_API}/${encodeURIComponent(panel.dataset.userId)}/permissions`, {
    method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ perms }),
  }));
  if (response.ok) { note("ok", "Permissions updated."); panel.hidden = true; load(); }
  else note("error", errorMessage(response));
});
$("search").addEventListener("input", UI.debounce(() => { view.q = $("search").value.trim(); view.offset = 0; load(); }, 250));
$("role-filter").addEventListener("change", () => { view.role = $("role-filter").value; view.offset = 0; load(); });

// --- Sessions panel ---

function closePanels() {
  $("sessions-panel").hidden = true;
  $("devices-panel").hidden = true;
  selectedUserId = null;
  selectedUserEmail = null;
  $("sessions-list").replaceChildren();
  $("sessions-loading").hidden = true;
  $("sessions-empty").hidden = true;
  $("sessions-actions").hidden = true;
  panelNote("sessions", "", "");
  $("devices-list").replaceChildren();
  $("devices-loading").hidden = true;
  $("devices-empty").hidden = true;
  panelNote("devices", "", "");
}

async function openSessions(user) {
  closePanels();
  selectedUserId = user.id;
  selectedUserEmail = user.email;
  $("sessions-user").textContent = user.email + " — " + user.role;
  $("sessions-user-email").textContent = user.email;
  $("sessions-panel").hidden = false;
  const reqId = ++sessionsRequestId;
  $("sessions-loading").hidden = false;
  $("sessions-list").replaceChildren();
  $("sessions-empty").hidden = true;
  $("sessions-actions").hidden = true;
  panelNote("sessions", "", "");
  try {
    const res = await fetch(`${USERS_API}/${encodeURIComponent(user.id)}/sessions`, { credentials: "same-origin" });
    if (reqId !== sessionsRequestId) return;
    if (!res.ok) { panelNote("sessions", "error", "Could not load sessions."); $("sessions-loading").hidden = true; return; }
    const data = await res.json();
    const sessions = data.sessions || [];
    renderSessions(sessions);
  } catch { if (reqId !== sessionsRequestId) return; panelNote("sessions", "error", "Could not load sessions."); }
  finally { if (reqId === sessionsRequestId) $("sessions-loading").hidden = true; }
}

function renderSessions(sessions) {
  const list = $("sessions-list");
  list.replaceChildren();
  if (sessions.length === 0) { $("sessions-empty").hidden = false; $("sessions-actions").hidden = true; return; }
  $("sessions-empty").hidden = true; $("sessions-actions").hidden = false;
  for (const s of sessions) {
    const row = document.createElement("div"); row.className = "row";
    const left = document.createElement("div");
    const sid = document.createElement("div"); sid.textContent = shortSid(s.sid);
    const meta = document.createElement("div"); meta.className = "label";
    const parts = [];
    if (s.created_at) parts.push("created " + new Date(s.created_at).toLocaleString());
    if (s.last_seen_at) parts.push("last seen " + new Date(s.last_seen_at).toLocaleString());
    meta.textContent = parts.join(" · ");
    left.appendChild(sid); left.appendChild(meta); row.appendChild(left);
    if (!s.current) {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "danger small-btn"; btn.textContent = "Revoke";
      btn.addEventListener("click", () => revokeSession(selectedUserId, s.sid, btn));
      row.appendChild(btn);
    } else { const tag = document.createElement("span"); tag.className = "small"; tag.textContent = "This session"; row.appendChild(tag); }
    list.appendChild(row);
  }
}

async function revokeSession(userId, sid, button) {
  if (!confirm("Revoke this session? The user will be signed out on that device.")) return;
  button.disabled = true; const reqId = ++sessionsRequestId;
  try {
    const res = await stepUp(() => UI.api(`/admin-v2/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" }));
    if (reqId !== sessionsRequestId) return;
    if (res.ok) { panelNote("sessions", "ok", "Session revoked."); await openSessions({ id: userId, email: selectedUserEmail, role: "" }); }
    else { button.disabled = false; panelNote("sessions", "error", "Could not revoke that session."); }
  } catch { button.disabled = false; panelNote("sessions", "error", "Could not revoke that session."); }
}

async function revokeAllSessions(userId, button) {
  if (!confirm("Revoke ALL sessions for this user? Every active session will be ended and the user will be signed out everywhere.")) return;
  button.disabled = true; const reqId = ++sessionsRequestId;
  try {
    const res = await stepUp(() => UI.api(`/admin-v2/users/${encodeURIComponent(userId)}/sessions/revoke-all`, { method: "POST" }));
    if (reqId !== sessionsRequestId) return;
    if (res.ok) { const data = await res.json(); panelNote("sessions", "ok", (data.revoked || 0) + " session" + (data.revoked === 1 ? "" : "s") + " revoked."); await openSessions({ id: userId, email: selectedUserEmail, role: "" }); }
    else { button.disabled = false; panelNote("sessions", "error", "Could not revoke sessions."); }
  } catch { button.disabled = false; panelNote("sessions", "error", "Could not revoke sessions."); }
}

async function openDevices(user) {
  closePanels(); selectedUserId = user.id; selectedUserEmail = user.email;
  $("devices-user").textContent = user.email + " — " + user.role;
  $("devices-user-email").textContent = user.email;
  $("devices-panel").hidden = false;
  const reqId = ++devicesRequestId;
  $("devices-loading").hidden = false;
  $("devices-list").replaceChildren();
  $("devices-empty").hidden = true;
  panelNote("devices", "", "");
  try {
    const res = await fetch(`${USERS_API}/${encodeURIComponent(user.id)}/devices`, { credentials: "same-origin" });
    if (reqId !== devicesRequestId) return;
    if (!res.ok) { panelNote("devices", "error", "Could not load devices."); $("devices-loading").hidden = true; return; }
    const data = await res.json(); const devices = data.devices || [];
    renderDevices(devices);
  } catch { if (reqId !== devicesRequestId) return; panelNote("devices", "error", "Could not load devices."); }
  finally { if (reqId === devicesRequestId) $("devices-loading").hidden = true; }
}

function renderDevices(devices) {
  const list = $("devices-list"); list.replaceChildren();
  if (devices.length === 0) { $("devices-empty").hidden = false; return; }
  $("devices-empty").hidden = true;
  for (const d of devices) {
    const row = document.createElement("div"); row.className = "row";
    const left = document.createElement("div");
    const label = document.createElement("div"); label.textContent = d.label || "This device";
    const meta = document.createElement("div"); meta.className = "label";
    const parts = [];
    if (d.status) parts.push(d.status);
    if (d.created_via) parts.push(d.created_via);
    if (d.last_seen_at) parts.push("last seen " + new Date(d.last_seen_at).toLocaleString());
    meta.textContent = parts.join(" · ");
    left.appendChild(label); left.appendChild(meta); row.appendChild(left);
    if (d.status !== "revoked") {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "danger small-btn"; btn.textContent = "Revoke";
      btn.addEventListener("click", () => revokeDevice(selectedUserId, d.id, btn));
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}

async function revokeDevice(userId, deviceId, button) {
  if (!confirm("Revoke this device? All sessions on that device will be ended and the device will no longer be trusted.")) return;
  button.disabled = true; const reqId = ++devicesRequestId;
  try {
    const res = await stepUp(() => UI.api(`/admin-v2/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" }));
    if (reqId !== devicesRequestId) return;
    if (res.ok) { panelNote("devices", "ok", "Device revoked."); await openDevices({ id: userId, email: selectedUserEmail, role: "" }); }
    else { button.disabled = false; panelNote("devices", "error", "Could not revoke that device."); }
  } catch { button.disabled = false; panelNote("devices", "error", "Could not revoke that device."); }
}

// ---- Lost-email requests (admin-v2/account-requests) ----
// The attempted username is user-typed: it is only ever put in with textContent.
async function loadRequests() {
  const panel = $("requests-panel");
  try {
    const res = await fetch(`${BASE}/admin-v2/account-requests`, { credentials: "same-origin" });
    if (res.status === 403 || res.status === 401) { panel.hidden = true; return; } // no permission: stay hidden
    if (!res.ok) { panel.hidden = false; panelNote("requests", "error", "Could not load requests."); return; }
    const { requests } = await res.json();
    panel.hidden = false;
    renderRequests(Array.isArray(requests) ? requests : []);
  } catch { panel.hidden = false; panelNote("requests", "error", "Could not load requests."); }
}

function renderRequests(requests) {
  const list = $("requests-list"); list.replaceChildren();
  panelNote("requests", "", "");
  if (requests.length === 0) {
    const none = document.createElement("p"); none.className = "muted small"; none.textContent = "No open requests.";
    list.appendChild(none); return;
  }
  for (const r of requests) {
    const row = document.createElement("div"); row.className = "row";
    const left = document.createElement("div");
    const who = document.createElement("div"); who.textContent = r.usernameAttempted;
    const meta = document.createElement("div"); meta.className = "label";
    meta.textContent = "asked " + new Date(r.createdAt).toLocaleString();
    left.appendChild(who); left.appendChild(meta); row.appendChild(left);
    for (const [action, label, cls] of [["resolved", "Resolved", "small-btn"], ["dismissed", "Dismiss", "ghost small-btn"]]) {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = cls; btn.textContent = label;
      btn.addEventListener("click", () => resolveRequest(r.id, action, btn));
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}

async function resolveRequest(id, action, button) {
  button.disabled = true;
  try {
    const res = await stepUp(() => fetch(`${BASE}/admin-v2/account-requests/${encodeURIComponent(id)}/resolve`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }));
    if (res.ok) { await loadRequests(); return; }
    button.disabled = false; panelNote("requests", "error", errorMessage(res));
  } catch { button.disabled = false; panelNote("requests", "error", "The operation could not be completed."); }
}
$("requests-refresh").addEventListener("click", loadRequests);

$("sessions-close").addEventListener("click", closePanels);
$("devices-close").addEventListener("click", closePanels);
$("sessions-revoke-all").addEventListener("click", () => { if (selectedUserId) revokeAllSessions(selectedUserId, $("sessions-revoke-all")); });

UI.refreshOnFocus(load);

Promise.all([loadRegistry(), load(), loadRequests()]);
