/* admin-auth v2 — sessions page. Two views: my own sessions (any signed-in user) and, for administrators,
 * every user's live sessions (searched + paged on the SERVER, so nothing is hidden by a client-side filter).
 * Every row names its user (email + user id, each with a copy button). All text goes in via textContent. */
"use strict";
const UI = window.AdminUI;
const { $, el } = UI;
const PAGE = 25;
const st = { scope: "mine", q: "", offset: 0, limit: PAGE, total: 0, me: null, reqId: 0, openDetail: null };

function detailRow(s) {
  const box = el("div", "row-detail"); const grid = el("div", "detail-grid");
  const add = (k, v, copy) => {
    const f = el("div"); f.appendChild(el("span", "k", k));
    const val = el("div", "v");
    if (copy && v) val.appendChild(UI.copyLine(v, k.toLowerCase(), "mono")); else val.textContent = v || "—";
    f.appendChild(val); grid.appendChild(f);
  };
  add("Session ID", s.sid, true); add("User ID", s.user_id, true); add("Email", s.user_email, true);
  add("Username", s.username); add("Role", s.role); add("Device ID", s.device_id, true);
  add("Device label", s.device_label); add("IP address", s.ip, true); add("Created", UI.fmtTime(s.created_at));
  add("Last activity", UI.fmtTime(s.last_seen_at)); add("Browser (full)", s.ua);
  box.appendChild(grid); return box;
}

async function endSession(s, button) {
  if (!confirm(`End this session for ${s.user_email}? They will be signed out on that device.`)) return;
  await UI.busy(button, async () => {
    const res = st.scope === "mine"
      ? await UI.api(`/auth/sessions/${encodeURIComponent(s.sid)}`, { method: "DELETE" })
      : await UI.withStepup(() => UI.api(`/admin-v2/users/${encodeURIComponent(s.user_id)}/sessions/${encodeURIComponent(s.sid)}`, { method: "DELETE" }));
    if (!res) { UI.note("error", "Could not reach the server."); return; }
    if (res.ok) { UI.note("ok", "Session ended."); await load(); }
    else UI.note("error", res.status === 403 ? "Fresh verification is required to end this session." : "Could not end that session.");
  });
}

function rowFor(s) {
  const row = el("div", "row"); row.setAttribute("role", "row");
  const who = el("div"); who.appendChild(UI.copyLine(s.user_email, "email", "cell-main"));
  who.appendChild(UI.copyLine(s.user_id, "user ID", "mono"));
  row.appendChild(UI.cell("User", who));
  const ua = s.ua || "Unknown device";
  row.appendChild(UI.cell("Device / Browser", UI.copyLine(ua, "browser details"), s.device_label || s.ip || ""));
  row.appendChild(UI.cell("Last activity", UI.fmtTime(s.last_seen_at), "Started " + UI.fmtTime(s.created_at)));
  const status = UI.cell("Status", s.current ? UI.badge("This device", "ok") : UI.badge("Active", ""));
  row.appendChild(status);
  const actions = el("div", "cell cell-actions right");
  const more = el("button", "btn-ghost btn-sm", "Details"); more.type = "button"; more.setAttribute("aria-expanded", "false");
  more.addEventListener("click", () => {
    const open = row.querySelector(".row-detail");
    if (open) { open.remove(); more.setAttribute("aria-expanded", "false"); st.openDetail = null; return; }
    row.appendChild(detailRow(s)); more.setAttribute("aria-expanded", "true"); st.openDetail = s.sid;
  });
  actions.appendChild(more);
  if (!s.current) {
    const end = el("button", "btn-danger btn-sm", "End"); end.type = "button";
    end.addEventListener("click", () => endSession(s, end));
    actions.appendChild(end);
  }
  row.appendChild(actions);
  if (st.openDetail === s.sid) { row.appendChild(detailRow(s)); more.setAttribute("aria-expanded", "true"); }
  return row;
}

function normalizeMine(data) {
  const me = data.user || {};
  return (data.sessions || []).map((s) => ({
    sid: s.sid, user_id: me.id || "", user_email: me.email || "", username: null, role: me.role || "",
    device_id: null, device_label: null, created_at: s.created_at, last_seen_at: s.last_seen_at,
    ip: s.ip, ua: s.ua, current: !!s.current,
  }));
}

async function load() {
  const my = ++st.reqId, list = $("list");
  if (!list.children.length) list.replaceChildren(UI.stateBox("", "Loading…"));
  let res;
  if (st.scope === "all") {
    const p = new URLSearchParams({ limit: String(st.limit), offset: String(st.offset) });
    if (st.q) p.set("q", st.q);
    res = await UI.api(`/admin-v2/sessions?${p}`);
  } else res = await UI.api("/auth/sessions");
  if (my !== st.reqId) return;                       // a newer request superseded this one
  if (!res) { list.replaceChildren(UI.stateBox("error", "Could not reach the server. Check your connection.")); return; }
  if (!res.ok) { list.replaceChildren(UI.stateBox("error", res.status === 403 ? "You do not have access to this view." : "Could not load sessions.")); return; }
  const data = await res.json();
  let rows;
  if (st.scope === "all") { rows = data.sessions || []; st.total = data.total || 0; }
  else {                                            // own list is small: filter it here (nothing is paged away)
    const all = normalizeMine(data), needle = st.q.toLowerCase();
    rows = needle ? all.filter((s) => [s.user_email, s.user_id, s.sid, s.ua, s.ip].join(" ").toLowerCase().includes(needle)) : all;
    st.total = rows.length; st.offset = 0;
  }
  $("count").textContent = `${st.total} session${st.total === 1 ? "" : "s"}`;
  if (!rows.length) {
    list.replaceChildren(UI.stateBox("", st.q ? `No sessions match “${st.q}”.` : "No active sessions."));
  } else list.replaceChildren(...rows.map(rowFor));
  if (st.scope === "all") UI.renderPager($("pager"), st, (o) => { st.offset = o; load(); });
  else $("pager").hidden = true;
}

/** Administrators get the all-users view; anyone else never sees the switch (and the server refuses them anyway). */
async function detectAdmin() {
  const res = await UI.api("/admin-v2/sessions?limit=1");
  if (res && res.ok) $("scope").classList.add("is-on");
}

$("search").addEventListener("input", UI.debounce(() => { st.q = $("search").value.trim(); st.offset = 0; load(); }, 250));
$("scope").addEventListener("change", () => {
  st.scope = $("scope").value; st.offset = 0; st.openDetail = null;
  $("subtitle").textContent = st.scope === "all" ? "Every signed-in user. End any session you don't recognize." : "End any session you don't recognize.";
  load();
});
$("revoke-others").addEventListener("click", (e) => UI.busy(e.currentTarget, async () => {
  if (!confirm("Sign out of every other session of yours?")) return;
  const res = await UI.api("/auth/sessions/revoke-others", { method: "POST" });
  if (!res || !res.ok) { UI.note("error", "Could not end other sessions."); return; }
  const { revoked } = await res.json();
  UI.note("ok", `${revoked} other session${revoked === 1 ? "" : "s"} ended.`); await load();
}));
$("logout").addEventListener("click", (e) => UI.busy(e.currentTarget, async () => {
  const res = await UI.api("/auth/logout", { method: "POST" });
  if (!res || !res.ok) { UI.note("error", "Could not sign out."); return; }
  UI.toSignIn();
}));

UI.refreshOnFocus(load);
detectAdmin();
load();
