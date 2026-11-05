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

function errorMessage(response) {
  return response.status === 403 ? "Fresh administrator verification is required." : "The operation could not be completed.";
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
  row.appendChild(actions);
  return row;
}

async function load() {
  const response = await fetch(USERS_API, { credentials: "same-origin" });
  if (response.status === 401 || response.status === 403) {
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

Promise.all([loadRegistry(), load()]);
