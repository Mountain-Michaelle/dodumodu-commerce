"use strict";

const $ = (id) => document.getElementById(id);
const BASE = window.ADMIN_BASE_PATH || "/admin";
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
  if (response.status !== 403) return response;
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

function rowFor(user) {
  const row = document.createElement("div");
  row.className = "row";
  const info = document.createElement("div");
  const name = document.createElement("div");
  name.textContent = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || user.email;
  const meta = document.createElement("div");
  meta.className = "label";
  meta.textContent = `${user.email} · ${user.role} · ${user.isActive ? "active" : "inactive"} · ${user.enrolled ? "TOTP enrolled" : "TOTP pending"}`;
  info.append(name, meta);
  row.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "links";
  const role = document.createElement("select");
  role.setAttribute("aria-label", `Role for ${user.email}`);
  for (const value of ["admin", "general", "mono"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = user.role === value;
    role.appendChild(option);
  }
  role.addEventListener("change", async () => {
    const response = await stepUp(() => fetch(`${USERS_API}/${encodeURIComponent(user.id)}`, {
      method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: role.value }),
    }));
    if (response.ok) { note("ok", "Role updated."); load(); }
    else note("error", errorMessage(response));
  });
  actions.appendChild(role);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "small-btn";
  toggle.textContent = user.isActive ? "Deactivate" : "Activate";
  toggle.addEventListener("click", async () => {
    const response = await stepUp(() => fetch(`${USERS_API}/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !user.isActive }),
    }));
    if (response.ok) { note("ok", "User updated."); load(); }
    else note("error", errorMessage(response));
  });
  actions.appendChild(toggle);

  if (user.role !== "admin") {
    const access = document.createElement("button");
    access.type = "button";
    access.className = "ghost small-btn";
    access.textContent = "Permissions";
    access.addEventListener("click", () => openAccess(user));
    actions.appendChild(access);
  }

  const sessionsBtn = document.createElement("button");
  sessionsBtn.type = "button";
  sessionsBtn.className = "ghost small-btn";
  sessionsBtn.textContent = "Sessions";
  sessionsBtn.addEventListener("click", () => openSessions(user));
  actions.appendChild(sessionsBtn);

  const devicesBtn = document.createElement("button");
  devicesBtn.type = "button";
  devicesBtn.className = "ghost small-btn";
  devicesBtn.textContent = "Devices";
  devicesBtn.addEventListener("click", () => openDevices(user));
  actions.appendChild(devicesBtn);

  row.appendChild(actions);
  return row;
}

async function load() {
  const response = await fetch(USERS_API, { credentials: "same-origin" });
  if (response.status === 401) {
    location.href = `${BASE}/sign-in/`;
    return;
  }
  if (!response.ok) {
    $("list").textContent = "Could not load users.";
    return;
  }
  const data = await response.json();
  users = data.users || [];
  const list = $("list");
  const query = $("search").value.trim().toLowerCase();
  const roleFilter = $("role-filter").value;
  const filtered = users.filter((user) =>
    (!roleFilter || user.role === roleFilter) &&
    (!query || [user.email, user.username, user.firstName, user.lastName].join(" ").toLowerCase().includes(query)));
  list.replaceChildren(...filtered.map(rowFor));
  if (filtered.length === 0) {
    list.textContent = "No users found.";
  }
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
$("search").addEventListener("input", load);
$("role-filter").addEventListener("change", load);

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
    const res = await stepUp(() => fetch(`${USERS_API}/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE", credentials: "same-origin" }));
    if (reqId !== sessionsRequestId) return;
    if (res.ok) { panelNote("sessions", "ok", "Session revoked."); await openSessions({ id: userId, email: selectedUserEmail, role: "" }); }
    else { button.disabled = false; panelNote("sessions", "error", "Could not revoke that session."); }
  } catch { button.disabled = false; panelNote("sessions", "error", "Could not revoke that session."); }
}

async function revokeAllSessions(userId, button) {
  if (!confirm("Revoke ALL sessions for this user? Every active session will be ended and the user will be signed out everywhere.")) return;
  button.disabled = true; const reqId = ++sessionsRequestId;
  try {
    const res = await stepUp(() => fetch(`${USERS_API}/${encodeURIComponent(userId)}/sessions/revoke-all`, { method: "POST", credentials: "same-origin" }));
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
    const res = await stepUp(() => fetch(`${USERS_API}/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", credentials: "same-origin" }));
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

const _origLoad = load;
load = async function () { closePanels(); await _origLoad(); };

Promise.all([loadRegistry(), load(), loadRequests()]);
