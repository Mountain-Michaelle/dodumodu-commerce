/* admin-auth v2 — invite redemption page. The token lives in the link's #fragment, so it is never sent to a
 * server or written to a URL log; it is removed from the address bar at once and posted in the request body.
 * A link PREVIEW (chat apps, scanners) only does a GET of this page, which redeems nothing: the person has to
 * press the button. */
"use strict";
const $ = (id) => document.getElementById(id);
const ADMIN_BASE = window.ADMIN_BASE_PATH || "/admin";

const token = decodeURIComponent((location.hash || "").replace(/^#/, ""));
try { history.replaceState(null, "", location.pathname + location.search); } catch { /* keep going */ }

function note(kind, text) { const n = $("note"); n.className = "note " + kind; n.textContent = text; n.hidden = !text; }

if (!token) {
  $("accept").hidden = true;
  note("error", "This invite link is incomplete. Ask the administrator for a new one.");
}

$("accept").addEventListener("click", async () => {
  const button = $("accept");
  if (button.disabled || !token) return;
  button.disabled = true; button.textContent = "Adding…";
  let res = null;
  try {
    res = await fetch(`${ADMIN_BASE}/auth/device/accept`, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
    });
  } catch { /* network */ }
  if (res && res.status === 200) {
    button.hidden = true;
    $("intro").textContent = "This browser has been added. Sign in to finish.";
    note("ok", "Device added.");
    const next = $("continue"); next.href = `${ADMIN_BASE}/sign-in/`; next.hidden = false;
  } else {
    button.disabled = false; button.textContent = "Trust this browser";
    note("error", res && res.status === 429
      ? "Too many attempts. Try again later."
      : "This invite link is invalid, expired or already used. Ask the administrator for a new one.");
  }
});
