/* admin-auth v2 — devices page (admins). List, invite (link + QR), revoke.
 * UA labels via textContent. A sensitive action without a fresh step-up gets a
 * 403; the UI re-prompts for an authenticator code, then retries (spec §5.9). */
"use strict";
const $ = (id) => document.getElementById(id);

function note(kind, text) { const n = $("note"); n.className = "note " + kind; n.textContent = text; n.hidden = !text; }

async function load() {
  const res = await fetch("/admin-v2/devices", { credentials: "same-origin" });
  if (res.status === 401 || res.status === 403) { location.href = "/admin/sign-in/"; return; }
  const { devices } = await res.json();
  const list = $("list");
  list.innerHTML = "";
  devices.forEach((d) => {
    const row = document.createElement("div");
    row.className = "row";
    const left = document.createElement("div");
    const label = document.createElement("div");
    label.textContent = d.label || "This device"; // textContent only
    const meta = document.createElement("div"); meta.className = "label";
    meta.textContent = `${d.status} · ${d.created_via} · ${new Date(d.last_seen_at).toLocaleString()}`;
    left.appendChild(label); left.appendChild(meta);
    row.appendChild(left);
    if (d.status !== "revoked") {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "danger small-btn"; btn.textContent = "Revoke";
      btn.addEventListener("click", () => revoke(d.id));
      row.appendChild(btn);
    }
    list.appendChild(row);
  });
}

async function withStepup(action) {
  // Try once; on 403 (step-up required) prompt for a code, step up, retry.
  let res = await action();
  if (res && res.status === 403) {
    const code = prompt("Re-enter your authenticator code:");
    if (!code) return res;
    const su = await fetch("/auth/stepup", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    if (su.status === 200) res = await action();
  }
  return res;
}

async function revoke(id) {
  const res = await withStepup(() =>
    fetch("/admin-v2/devices/" + encodeURIComponent(id), { method: "DELETE", credentials: "same-origin" }));
  if (res && res.status === 200) { note("ok", "Device revoked."); load(); }
  else { note("error", "Could not revoke that device."); }
}

$("invite").addEventListener("click", async () => {
  const res = await withStepup(() =>
    fetch("/admin-v2/devices/invite", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: "{}" }));
  if (res && res.status === 200) {
    const { invite_url } = await res.json();
    const box = $("invite-box");
    box.innerHTML = "";
    const p = document.createElement("div"); p.className = "small";
    p.textContent = "Open this link on the new device (expires in 15 minutes):";
    const a = document.createElement("a"); a.href = invite_url; a.textContent = invite_url;
    box.appendChild(p); box.appendChild(a); box.hidden = false;
  } else { note("error", "Could not create an invite."); }
});

load();

