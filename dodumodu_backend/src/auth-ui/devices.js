/* admin-auth v2 — devices page (administrators). Lists EVERY administrator's trusted devices with the owner shown
 * (email + user id, copyable), searched and paged on the server. Actions: details, revoke (untrust), and a
 * single-use invite link for a new device. Only actions the server implements are offered. All text via textContent. */
"use strict";
const UI = window.AdminUI;
const { $, el } = UI;
const st = { q: "", offset: 0, limit: 25, total: 0, reqId: 0, me: null, openDetail: null };

const STATUS = { active: ["Trusted", "ok"], pending: ["Pending", "warn"], revoked: ["Revoked", "bad"] };

function detailRow(d) {
  const box = el("div", "row-detail"); const grid = el("div", "detail-grid");
  const add = (k, v, copy) => {
    const f = el("div"); f.appendChild(el("span", "k", k));
    const val = el("div", "v");
    if (copy && v) val.appendChild(UI.copyLine(v, k.toLowerCase(), "mono")); else val.textContent = v || "—";
    f.appendChild(val); grid.appendChild(f);
  };
  add("Device ID", d.id, true); add("User ID", d.user_id, true); add("Email", d.user_email, true);
  add("Username", d.username); add("Role", d.role); add("Label", d.label); add("Status", d.status);
  add("Created via", d.created_via); add("Last seen", UI.fmtTime(d.last_seen_at)); add("Expires", UI.fmtTime(d.expires_at));
  add("Last network", d.last_ip_prefix); add("Country", d.last_country); add("Live sessions", String(d.live_sessions ?? 0));
  box.appendChild(grid); return box;
}

async function revoke(d, button) {
  const mine = st.me && d.user_id === st.me;
  if (!confirm(`Revoke ${d.label || "this device"} for ${d.user_email}? Its sessions will be ended${mine ? " (this may be your own device)" : ""}.`)) return;
  await UI.busy(button, async () => {
    const res = await UI.withStepup(() => UI.api(`/admin-v2/users/${encodeURIComponent(d.user_id)}/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" }));
    if (!res) { UI.note("error", "Could not reach the server."); return; }
    if (res.ok) { UI.note("ok", "Device revoked."); await load(); }
    else UI.note("error", res.status === 403 ? "Fresh verification is required to revoke this device." : "Could not revoke that device.");
  });
}

function rowFor(d) {
  const row = el("div", "row"); row.setAttribute("role", "row");
  const who = el("div"); who.appendChild(UI.copyLine(d.user_email, "email", "cell-main"));
  who.appendChild(UI.copyLine(d.user_id, "user ID", "mono"));
  row.appendChild(UI.cell("User", who));
  row.appendChild(UI.cell("Device", UI.copyLine(d.label || "Unnamed device", "device name"), null));
  row.lastChild.appendChild(UI.copyLine(d.id, "device ID", "mono"));
  const [text, kind] = STATUS[d.status] || [d.status, ""];
  row.appendChild(UI.cell("Trust status", UI.badge(text, kind)));
  row.appendChild(UI.cell("Created via", d.created_via));
  row.appendChild(UI.cell("Last seen", UI.fmtTime(d.last_seen_at), d.last_ip_prefix ? "Network " + d.last_ip_prefix : ""));
  const actions = el("div", "cell cell-actions right");
  const more = el("button", "btn-ghost btn-sm", "Details"); more.type = "button"; more.setAttribute("aria-expanded", "false");
  more.addEventListener("click", () => {
    const open = row.querySelector(".row-detail");
    if (open) { open.remove(); more.setAttribute("aria-expanded", "false"); st.openDetail = null; return; }
    row.appendChild(detailRow(d)); more.setAttribute("aria-expanded", "true"); st.openDetail = d.id;
  });
  actions.appendChild(more);
  if (d.status !== "revoked") {
    const btn = el("button", "btn-danger btn-sm", "Revoke"); btn.type = "button";
    btn.addEventListener("click", () => revoke(d, btn));
    actions.appendChild(btn);
  }
  row.appendChild(actions);
  if (st.openDetail === d.id) { row.appendChild(detailRow(d)); more.setAttribute("aria-expanded", "true"); }
  return row;
}

async function load() {
  const my = ++st.reqId, list = $("list");
  if (!list.children.length) list.replaceChildren(UI.stateBox("", "Loading…"));
  const p = new URLSearchParams({ scope: "all", limit: String(st.limit), offset: String(st.offset) });
  if (st.q) p.set("q", st.q);
  const res = await UI.api(`/admin-v2/devices?${p}`);
  if (my !== st.reqId) return;
  if (!res) { list.replaceChildren(UI.stateBox("error", "Could not reach the server. Check your connection.")); return; }
  if (res.status === 403) { list.replaceChildren(UI.stateBox("error", "Only administrators can manage trusted devices.")); $("pager").hidden = true; return; }
  if (!res.ok) { list.replaceChildren(UI.stateBox("error", "Could not load trusted devices.")); return; }
  const data = await res.json();
  const rows = data.devices || [];
  st.total = data.total || 0;
  $("count").textContent = `${st.total} device${st.total === 1 ? "" : "s"}`;
  list.replaceChildren(...(rows.length ? rows.map(rowFor)
    : [UI.stateBox("", st.q ? `No devices match “${st.q}”.` : "No trusted devices.")]));
  UI.renderPager($("pager"), st, (o) => { st.offset = o; load(); });
}

$("search").addEventListener("input", UI.debounce(() => { st.q = $("search").value.trim(); st.offset = 0; load(); }, 250));

$("invite").addEventListener("click", (e) => UI.busy(e.currentTarget, async () => {
  const res = await UI.withStepup(() => UI.api("/admin-v2/devices/invite", { method: "POST" }));
  if (!res || res.status !== 200) {
    UI.note("error", res && res.status === 429 ? "Too many invites. Try again later." : "Could not create an invite.");
    return;
  }
  const { invite_url } = await res.json();
  const box = $("invite-box"); box.replaceChildren();
  box.appendChild(el("div", "small", "Open this link on the new device (single use, expires in 15 minutes). Anyone with the link can add a device, so share it only with yourself:"));
  const line = el("div", "invite-line");
  const a = el("a", "", invite_url); a.href = invite_url; a.rel = "noopener noreferrer";
  line.append(a, UI.copyButton(invite_url, "invite link")); box.appendChild(line); box.hidden = false;
  UI.note("", "");
}));

(async () => {
  const me = await UI.api("/admin-v2/devices");        // also proves the session is alive (401 -> sign-in)
  if (me && me.ok) { const d = await me.json(); st.me = d.user && d.user.id; }
  UI.refreshOnFocus(load);
  load();
})();
