/* admin-auth v2 — sessions page. Renders UA labels with textContent (never
 * innerHTML) so a stored user-agent can't inject markup (spec §5.9). */
"use strict";
const $ = (id) => document.getElementById(id);

function note(kind, text) { const n = $("note"); n.className = "note " + kind; n.textContent = text; n.hidden = !text; }

async function load() {
  const res = await fetch("/auth/sessions", { credentials: "same-origin" });
  if (res.status === 401) { location.href = "/auth-ui/login.html"; return; }
  const { sessions } = await res.json();
  const list = $("list");
  list.innerHTML = "";
  sessions.forEach((s) => {
    const row = document.createElement("div");
    row.className = "row";
    const left = document.createElement("div");
    const when = document.createElement("div"); when.className = "label";
    when.textContent = new Date(s.last_seen_at).toLocaleString();
    const ua = document.createElement("div"); ua.className = "small";
    ua.textContent = s.ua || "Unknown device"; // textContent, never innerHTML
    left.appendChild(when); left.appendChild(ua);
    row.appendChild(left);
    if (!s.current) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "danger small-btn"; btn.textContent = "End";
      btn.addEventListener("click", async () => {
        await fetch("/auth/sessions/" + encodeURIComponent(s.sid), { method: "DELETE", credentials: "same-origin" });
        load();
      });
      row.appendChild(btn);
    } else {
      const tag = document.createElement("span"); tag.className = "small"; tag.textContent = "This device";
      row.appendChild(tag);
    }
    list.appendChild(row);
  });
}

$("revoke-others").addEventListener("click", async () => {
  await fetch("/auth/sessions/revoke-others", { method: "POST", credentials: "same-origin" });
  note("ok", "Other sessions ended."); load();
});
$("logout").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  location.href = "/auth-ui/login.html";
});
load();
