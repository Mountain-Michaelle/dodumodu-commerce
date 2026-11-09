/* admin-auth v2 — devices page (admins). List, invite (link + QR), revoke.
 * UA labels via textContent. A sensitive action without a fresh step-up gets a
 * 403; the UI re-prompts for an authenticator code, then retries (spec §5.9). */
"use strict";
const $ = (id) => document.getElementById(id);
const ADMIN_BASE = window.ADMIN_BASE_PATH || "/admin";

function note(kind, text) { const n = $("note"); n.className = "note " + kind; n.textContent = text; n.hidden = !text; }

async function load() {
  const res = await fetch(`${ADMIN_BASE}/admin-v2/devices`, { credentials: "same-origin" });
  if (res.status === 401) { location.href = `${ADMIN_BASE}/sign-in/`; return; }
  if (!res.ok) { note("error", "Could not load trusted devices."); return; }
  const { devices } = await res.json();
  const list = $("list");
  list.innerHTML = "";
  devices.forEach((d) => {
    const row = document.createElement("div");
    row.className = "row";

    // Col 1: Device name
    const label = document.createElement("div"); label.className = "label";
    label.textContent = d.label || "This device"; // textContent only
    row.appendChild(label);

    // Col 2: Device identifier (truncated) + copy button
    const idText = d.id || "";
    const idDisplay = idText.length > 30 ? idText.slice(0, 30) + "..." : idText;
    const idCell = document.createElement("div");
    idCell.style.display = "flex";
    idCell.style.alignItems = "center";
    idCell.style.gap = "8px";

    const deviceId = document.createElement("span"); deviceId.className = "device-id";
    deviceId.textContent = idDisplay; deviceId.title = idText;
    idCell.appendChild(deviceId);

    const idCopyBtn = document.createElement("button");
    idCopyBtn.type = "button";
    idCopyBtn.className = "btn-copy";
    idCopyBtn.title = "Copy device identifier";
    idCopyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    idCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(idText);
        idCopyBtn.classList.add("copied");
        setTimeout(() => idCopyBtn.classList.remove("copied"), 1500);
      } catch {
        idCopyBtn.classList.add("copy-error");
        setTimeout(() => idCopyBtn.classList.remove("copy-error"), 1500);
      }
    });
    idCell.appendChild(idCopyBtn);
    row.appendChild(idCell);

    // Col 3: Trust Status
    const status = document.createElement("span"); status.className = "trust-status"; status.textContent = d.status;
    row.appendChild(status);

    // Col 4: Created Via
    const via = document.createElement("span"); via.className = "created-via"; via.textContent = d.created_via;
    row.appendChild(via);

    // Col 5: Last Seen
    const seen = document.createElement("span"); seen.className = "last-seen"; seen.textContent = new Date(d.last_seen_at).toLocaleString();
    row.appendChild(seen);

    // Col 6: Revoke button
    if (d.status !== "revoked") {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "danger small-btn"; btn.textContent = "Revoke";
      btn.addEventListener("click", () => {
        if (!confirm(`Revoke ${d.label || "this device"}? Its sessions will be ended.`)) return;
        revoke(d.id, btn);
      });
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
    const su = await fetch(`${ADMIN_BASE}/auth/stepup`, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    if (su.status === 200) res = await action();
  }
  return res;
}

async function revoke(id, button) {
  button.disabled = true;
  const res = await withStepup(() =>
    fetch(`${ADMIN_BASE}/admin-v2/devices/` + encodeURIComponent(id), { method: "DELETE", credentials: "same-origin" }));
  if (res && res.status === 200) { note("ok", "Device revoked."); await load(); }
  else { button.disabled = false; note("error", "Could not revoke that device."); }
}

$("invite").addEventListener("click", async () => {
  const button = $("invite");
  button.disabled = true;
  const res = await withStepup(() =>
    fetch(`${ADMIN_BASE}/admin-v2/devices/invite`, { method: "POST", credentials: "same-origin",
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
  button.disabled = false;
});

load();
