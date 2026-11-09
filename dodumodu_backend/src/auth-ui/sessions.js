/* admin-auth v2 — sessions page. Renders UA labels with textContent (never
 * innerHTML) so a stored user-agent can't inject markup (spec §5.9). */
"use strict";
const $ = (id) => document.getElementById(id);
const ADMIN_BASE = window.ADMIN_BASE_PATH || "/admin";

function note(kind, text) { const n = $("note"); n.className = "note " + kind; n.textContent = text; n.hidden = !text; }

async function load() {
  const res = await fetch(`${ADMIN_BASE}/auth/sessions`, { credentials: "same-origin" });
  if (res.status === 401) { location.href = `${ADMIN_BASE}/sign-in/`; return; }
  if (!res.ok) { note("error", "Could not load sessions."); return; }
  const { sessions } = await res.json();
  const list = $("list");
  list.innerHTML = "";
  sessions.forEach((s) => {
    const row = document.createElement("div");
    row.className = "row";

    // Col 1: Device / Browser (truncated + copy)
    const uaText = s.ua || "Unknown device";
    const displayText = uaText.length > 30 ? uaText.slice(0, 30) + "..." : uaText;
    const ua = document.createElement("div"); ua.className = "small";
    ua.textContent = displayText; // textContent, never innerHTML
    ua.title = uaText;

    const deviceCell = document.createElement("div");
    deviceCell.style.display = "flex";
    deviceCell.style.alignItems = "center";
    deviceCell.style.gap = "8px";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-copy";
    copyBtn.title = "Copy device";
    copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(uaText);
        copyBtn.classList.add("copied");
        setTimeout(() => copyBtn.classList.remove("copied"), 1500);
      } catch {
        copyBtn.classList.add("copy-error");
        setTimeout(() => copyBtn.classList.remove("copy-error"), 1500);
      }
    });

    deviceCell.appendChild(ua);
    deviceCell.appendChild(copyBtn);
    row.appendChild(deviceCell);

    // Col 2: Last Activity
    const when = document.createElement("div"); when.className = "label";
    when.textContent = new Date(s.last_seen_at).toLocaleString();
    row.appendChild(when);

    // Col 3 / Col 4: Status badge or End button
    if (!s.current) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "danger small-btn"; btn.textContent = "End";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const response = await fetch(`${ADMIN_BASE}/auth/sessions/` + encodeURIComponent(s.sid), { method: "DELETE", credentials: "same-origin" });
        if (!response.ok) {
          btn.disabled = false;
          note("error", "Could not end that session.");
          return;
        }
        note("ok", "Session ended.");
        await load();
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
  const button = $("revoke-others");
  button.disabled = true;
  const response = await fetch(`${ADMIN_BASE}/auth/sessions/revoke-others`, { method: "POST", credentials: "same-origin" });
  button.disabled = false;
  if (!response.ok) { note("error", "Could not end other sessions."); return; }
  const { revoked } = await response.json();
  note("ok", `${revoked} other session${revoked === 1 ? "" : "s"} ended.`);
  await load();
});
$("logout").addEventListener("click", async () => {
  const response = await fetch(`${ADMIN_BASE}/auth/logout`, { method: "POST", credentials: "same-origin" });
  if (!response.ok) { note("error", "Could not sign out."); return; }
  location.href = `${ADMIN_BASE}/sign-in/`;
});
load();
