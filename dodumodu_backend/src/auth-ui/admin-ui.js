/* admin-auth v2 — helpers shared by the sessions, devices and users pages. No dependencies, no inline script.
 * Everything the server sends is put on the page with textContent (never innerHTML). */
"use strict";
(function () {
  const BASE = window.ADMIN_BASE_PATH || "/admin";
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /** "2026-11-09 10:20:54.940543-05" (Postgres) -> a Date every browser parses. */
  function parseTime(value) {
    if (!value) return null;
    let s = String(value).trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
    s = s.replace(/([+-]\d{2})$/, "$1:00");
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function fmtTime(value) { const d = parseTime(value); return d ? d.toLocaleString() : "—"; }

  function debounce(fn, ms) {
    let t = null;
    return function () { const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); };
  }

  /** Page-level message line (#note). */
  function note(kind, text) {
    const n = $("note"); if (!n) return;
    n.className = "note " + kind; n.textContent = text; n.hidden = !text;
  }

  /** Session gone while the page is open -> back to sign-in. Everything else is returned to the caller. */
  function toSignIn() { location.href = BASE + "/sign-in/"; }
  async function api(path, opts) {
    const o = Object.assign({ credentials: "same-origin" }, opts || {});
    // The server requires a JSON content type on every unsafe method (CSRF guard), even with no body.
    if (o.method && o.method !== "GET") {
      o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
      if (o.body === undefined) o.body = "{}";
    }
    let res;
    try { res = await fetch(BASE + path, o); }
    catch { return null; }                       // network error: the caller shows its own message
    if (res.status === 401) {
      // 401 = session gone -> sign-in. The neutral "rejected" 401 (a stale id, a wrong code) is NOT a lost session.
      let msg = "";
      try { msg = String((await res.clone().json()).error || ""); } catch { /* not JSON */ }
      if (!/^(Invalid or expired code|Invalid code)$/.test(msg)) { toSignIn(); return null; }
    }
    return res;
  }

  /** Sensitive action: on 403 ask for an authenticator code, step up, retry once. */
  async function withStepup(action) {
    let res = await action();
    if (res && res.status === 403) {
      const code = prompt("Re-enter your authenticator code:");
      if (!code) return res;
      const su = await api("/auth/stepup", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      });
      if (su && su.status === 200) res = await action();
    }
    return res;
  }

  /** Run `fn` once at a time for a button: disabled + spinner while it runs, restored afterwards. */
  async function busy(button, fn) {
    if (!button || button.disabled) return undefined;
    button.disabled = true; button.classList.add("is-loading");
    try { return await fn(); }
    finally { button.disabled = false; button.classList.remove("is-loading"); }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {                                          // insecure-context / older browsers
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy"); ta.remove(); return ok;
    } catch { return false; }
  }

  const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  /** Copies the REAL value (never the shortened text on screen) and says whether it worked. */
  function copyButton(value, what) {
    const b = el("button"); b.type = "button"; b.className = "btn-copy";
    b.title = "Copy " + what; b.setAttribute("aria-label", "Copy " + what);
    b.innerHTML = COPY_ICON;                       // constant markup, no server data
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await copyText(String(value));
      b.classList.add(ok ? "copied" : "copy-error");
      b.title = ok ? "Copied" : "Copy failed — select the value and copy it manually";
      note(ok ? "ok" : "error", ok ? what + " copied." : "Could not copy " + what + ".");
      setTimeout(() => { b.classList.remove("copied", "copy-error"); b.title = "Copy " + what; }, 1500);
    });
    return b;
  }

  /** A value on one truncated line, full value in the tooltip, with its copy button. */
  function copyLine(value, what, cls) {
    const wrap = el("div", "copy-line");
    const v = el("span", "val " + (cls || ""), value || "—"); v.title = value || "";
    wrap.appendChild(v);
    if (value) wrap.appendChild(copyButton(value, what));
    return wrap;
  }

  /** Two-line cell: the main text and a muted line under it. */
  function cell(label, main, sub, extraCls) {
    const c = el("div", "cell " + (extraCls || "")); if (label) c.setAttribute("data-label", label);
    if (main instanceof Node) c.appendChild(main); else c.appendChild(el("div", "cell-main", main));
    if (sub) c.appendChild(sub instanceof Node ? sub : el("div", "cell-sub", sub));
    return c;
  }

  function badge(text, kind) { return el("span", "badge " + (kind || ""), text); }

  function stateBox(kind, text) { return el("div", "state " + (kind || ""), text); }

  /** Prev / next + "x–y of n". `onPage(newOffset)` reloads. */
  function renderPager(host, st, onPage) {
    host.replaceChildren();
    if (!st.total) { host.hidden = true; return; }
    host.hidden = false;
    const from = st.offset + 1, to = Math.min(st.offset + st.limit, st.total);
    host.appendChild(el("span", "muted small", `${from}–${to} of ${st.total}`));
    const nav = el("div", "pager-nav");
    const prev = el("button", "btn-ghost btn-sm", "Previous"); prev.type = "button"; prev.disabled = st.offset <= 0;
    const next = el("button", "btn-ghost btn-sm", "Next"); next.type = "button"; next.disabled = st.offset + st.limit >= st.total;
    prev.addEventListener("click", () => onPage(Math.max(0, st.offset - st.limit)));
    next.addEventListener("click", () => onPage(st.offset + st.limit));
    nav.append(prev, next); host.appendChild(nav);
  }

  /** Keep a list honest while the tab stays open: reload when the person comes back (also notices an expired session). */
  function refreshOnFocus(load, minGapMs) {
    let last = Date.now();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - last > (minGapMs || 30000)) { last = Date.now(); load(); }
    });
  }

  window.AdminUI = { BASE, $, el, fmtTime, parseTime, debounce, note, api, withStepup, busy, copyText, copyButton,
    copyLine, cell, badge, stateBox, renderPager, refreshOnFocus, toSignIn };
})();
