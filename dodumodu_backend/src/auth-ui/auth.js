// ===== FILE: <your-static-dir>/auth.js  (served at /admin/assets/auth.js) =====
/* admin-auth v2 UI — vanilla JS, external file (CSP: script-src 'self').
 * One input per stage, rendered from the server's `next`. No tokens in
 * localStorage. Neutral errors; 429 shows a server countdown; 503 keeps the
 * form usable ("nothing was counted"). Disables submit while in flight.
 */
import { makeQrElement } from "./qr-logo.mjs";

const AUTH = `${window.ADMIN_BASE_PATH || "/admin"}/auth`;
const ENROLL_TTL_SECS = 120; // fallback; the server sends expires_in
const $ = (id) => document.getElementById(id);
// CHANGED: the `hidden` attribute loses to any author CSS `display:` rule
// (e.g. `button { display:block }`), so also set inline display via CSSOM
// (allowed under a strict CSP). Guarantees hide/show regardless of auth.css.
const setHidden = (id, hidden) => {
  const el = $(id);
  if (!el) return;
  el.hidden = hidden;
  el.style.display = hidden ? "none" : "";
};

const state = {
  stage: "email",      // email | otp | totp | totp_enroll | backup_codes | recovery | ready | done
  device: false,
  strict: false,
  showBackup: true,
  useBackup: false,
  locked: false,
  enrollStarted: false,
  enrollSaved: false,   // user pressed "I saved it" (reveals the code input)
  enrollSeq: 0,
  enrollTimer: null,
  enrollDeadline: 0,
  cooldownUntil: 0,
  timer: null,
  inFlight: false,
};

function showNote(kind, text) {
  const n = $("note");
  if (!n) return;
  n.className = "note " + kind;
  n.textContent = text;
  n.hidden = !text;
}
function setHint(text) { const h = $("hint"); if (!h) return; h.textContent = text || ""; h.hidden = !text; }
function busy(b) { const s = $("submit"); if (s) s.disabled = b || state.locked; }

async function guarded(fn) {
  if (state.inFlight) return;
  state.inFlight = true;
  busy(true);
  try { await fn(); } finally { state.inFlight = false; busy(false); }
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { status: 0, data: { error: "Unable to reach the server. Check your connection and try again." } };
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

const STAGES = {
  email:        { label: "Email",         type: "email", ac: "username",      im: "email",   btn: "Continue", sub: "Enter your email to receive a one-time code." },
  otp:          { label: "Code",          type: "text",  ac: "one-time-code", im: "text",    btn: "Verify",   sub: "Enter the code we emailed you." },
  totp:         { label: "Authenticator", type: "text",  ac: "one-time-code", im: "numeric", btn: "Verify",   sub: "Enter the 6-digit code from your authenticator app." },
  totp_enroll:  { label: "Authenticator", type: "text",  ac: "one-time-code", im: "numeric", btn: "Verify",   sub: "Enter the 6-digit code from your authenticator app." },
  recovery:     { label: "Backup code",   type: "text",  ac: "one-time-code", im: "text",    btn: "Verify",   sub: "Enter one of your backup codes (XXXXX-XXXXX)." },
  backup_codes: { label: "Ready",         type: "text",  ac: "off",           im: "text",    btn: "Continue", sub: "Backup codes saved. Continue to finish signing in." },
  ready:        { label: "Ready",         type: "text",  ac: "off",           im: "text",    btn: "Sign in",  sub: "All checks passed. Continue to sign in." },
};
const NEEDS_INPUT = new Set(["email", "otp", "totp", "totp_enroll", "recovery"]);
const ENROLL_GATED_SUB = "Set up your authenticator app first.";

// Strip whitespace/dashes people paste from authenticator apps ("123 456").
function normalizeCode(raw) {
  const v = String(raw || "").trim();
  if (state.stage === "email") return v;
  if (state.stage === "recovery" || state.useBackup) return v.replace(/\s+/g, "");
  if (state.stage === "totp" || state.stage === "totp_enroll") return v.replace(/[\s-]/g, "");
  return v.replace(/\s+/g, "");
}

// ---- Enrolment gate: QR first, code input only after "I saved it" ----
function enrollGated() { return state.stage === "totp_enroll" && !state.enrollSaved; }

// Safety net: the HTML already places #enroll-box above #form. If someone
// reorders the markup, this restores it (no-op when already correct).
function placeEnrollAboveForm() {
  const box = $("enroll-box"), form = $("form");
  if (!box || !form || !form.parentNode || box.parentNode !== form.parentNode) return;
  if (box.nextElementSibling !== form) form.parentNode.insertBefore(box, form);
}

function applyGate() {
  if (state.stage === "totp_enroll") placeEnrollAboveForm();
  if (enrollGated()) {
    setHidden("field-label", true);
    setHidden("input", true);
    setHidden("submit", true);
    return;
  }
  const needs = NEEDS_INPUT.has(state.stage);
  setHidden("field-label", !needs);
  setHidden("input", !needs);
  setHidden("submit", false);
}

function stopQrRefresh() {
  if (state.enrollTimer) { clearInterval(state.enrollTimer); state.enrollTimer = null; }
}
function hideEnrollBox() {
  stopQrRefresh();
  const box = $("enroll-box");
  if (box) { box.innerHTML = ""; setHidden("enroll-box", true); } // CHANGED
}

function render() {
  const cfg = STAGES[state.stage];
  if (!cfg) { hideEnrollBox(); setHidden("form", true); return; }
  // Leaving totp_enroll: stop the expiry timer + clear the box; returning
  // resets the flags so a fresh secret is fetched and the gate closes again.
  if (state.stage !== "totp_enroll") {
    hideEnrollBox();
    state.enrollStarted = false;
    state.enrollSaved = false;
    state.enrollSeq++; // invalidate any in-flight enrollStart
  }
  setHidden("form", false);
  if (state.stage !== "totp" && state.stage !== "recovery") state.useBackup = false;

  const needsInput = NEEDS_INPUT.has(state.stage);
  const input = $("input");
  const label = $("field-label");
  if (label) label.textContent = cfg.label;          // CHANGED
  setHidden("field-label", !needsInput);             // CHANGED
  setHidden("input", !needsInput);                   // CHANGED
  input.type = cfg.type;
  input.autocomplete = cfg.ac;
  input.inputMode = cfg.im;
  input.placeholder = state.stage === "recovery" ? "XXXXX-XXXXX" : "";
  input.value = "";

  $("submit").textContent = cfg.btn;
  $("subtitle").textContent = enrollGated() ? ENROLL_GATED_SUB : cfg.sub;
  if (state.strict && state.stage === "totp") {
    setHint("Extra checks are on because your network changed.");
  } else { setHint(""); }

  setHidden("backup-link", !(state.stage === "totp" && state.showBackup && !state.strict && !state.useBackup));
  const resend = $("resend-link");
  if (resend) { resend.hidden = state.stage !== "otp"; tick(); }
  setHidden("device-link", !(state.stage === "email" && state.device));

  applyGate();
  if (needsInput && !enrollGated()) input.focus();

  if (state.stage === "totp_enroll" && !state.enrollStarted) {
    state.enrollStarted = true;
    enrollStart();
  }
}

function showEnrollRetry(message) {
  const box = $("enroll-box");
  if (!box) return;
  box.innerHTML = "";
  if (message) {
    const p = document.createElement("div");
    p.className = "qr-hint";
    p.textContent = message;
    box.appendChild(p);
  }
  const retry = document.createElement("button");
  retry.type = "button"; retry.className = "ghost"; retry.textContent = "Get a new QR code";
  retry.addEventListener("click", () => { state.enrollStarted = true; enrollStart(); });
  box.appendChild(retry);
  setHidden("enroll-box", false); // CHANGED
}

// totp_enroll: POST /auth/totp/enroll/start, render QR code + setup key.
// Calling it again re-issues a NEW secret (the old unconfirmed one dies), so
// the code input is hidden again until the user re-adds it and presses the button.
async function enrollStart() {
  const seq = ++state.enrollSeq;
  stopQrRefresh();
  state.enrollSaved = false;
  $("subtitle").textContent = ENROLL_GATED_SUB;
  applyGate();
  showNote("warn", "Loading your authenticator setup…");
  const { status, data } = await api(AUTH + "/totp/enroll/start", {});
  if (seq !== state.enrollSeq || state.stage !== "totp_enroll") return; // stale

  if (status !== 200) {
    state.enrollStarted = false; // allow retry
    if (status === 429) { startLockCountdown(data && data.retry_after); return; }
    if (status === 401) {
      showNote("error", "Setup session expired. Enter your email again to start over.");
      state.stage = "email";
      render();
      return;
    }
    showNote("error", status === 0 && data && data.error ? data.error : "Could not load the authenticator setup. Please try again.");
    showEnrollRetry();
    return;
  }

  const { secret, otpauth_uri } = data || {};
  if (!secret || !otpauth_uri) {
    state.enrollStarted = false;
    showNote("error", "Sign-in response was incomplete. Please try again.");
    showEnrollRetry();
    return;
  }
  showNote("", "");

  const box = $("enroll-box");
  box.innerHTML = "";

  const head = document.createElement("strong");
  head.textContent = "Scan with your authenticator app (shown once).";
  box.appendChild(head);

  // QR as inline SVG nodes (no data: URL, so CSP img-src cannot block it).
  const qrPanel = document.createElement("div");
  qrPanel.className = "qr-panel";
  try {
    qrPanel.appendChild(makeQrElement(otpauth_uri, { size: 220, ecc: "M" }));
  } catch {
    showNote("error", "Could not draw the QR code. Use the setup key below instead.");
  }
  box.appendChild(qrPanel);

  const setup = document.createElement("div");
  setup.className = "qr-setup";
  const keyLabel = document.createElement("div");
  keyLabel.textContent = "Setup key (enter manually if you can't scan):";
  keyLabel.style.fontSize = "0.75rem";
  keyLabel.style.color = "var(--muted)";
  keyLabel.style.marginBottom = "2px";
  const keyText = document.createElement("div");
  keyText.className = "qr-key";
  keyText.textContent = secret;
  setup.appendChild(keyLabel);
  setup.appendChild(keyText);
  box.appendChild(setup);

  const hint = document.createElement("div");
  hint.className = "qr-hint";
  hint.textContent = "Add it to your authenticator app, then press the button below to enter the 6-digit code.";
  box.appendChild(hint);

  const expiry = document.createElement("div");
  expiry.className = "qr-hint";
  box.appendChild(expiry);

  // Reveals the code input + Verify button (below this box).
  const ok = document.createElement("button");
  ok.type = "button"; ok.className = "ghost"; ok.textContent = "I saved it";
  ok.addEventListener("click", () => {
    state.enrollSaved = true;
    ok.hidden = true;
    ok.style.display = "none";
    $("subtitle").textContent = STAGES.totp_enroll.sub;
    applyGate();
    $("input").focus();
  });
  box.appendChild(ok);
  setHidden("enroll-box", false); // CHANGED
  placeEnrollAboveForm();

  // Expiry countdown from the server's real TTL. On expiry, offer a fresh QR
  // (delete the old entry from your authenticator first).
  const ttl = Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : ENROLL_TTL_SECS;
  state.enrollDeadline = Date.now() + ttl * 1000;
  const update = () => {
    const left = Math.ceil((state.enrollDeadline - Date.now()) / 1000);
    if (left > 0) { expiry.textContent = `Setup key expires in ${formatCountdown(left)}.`; return; }
    stopQrRefresh();
    state.enrollSaved = false;
    $("subtitle").textContent = ENROLL_GATED_SUB;
    applyGate();
    showEnrollRetry("This setup key has expired. Remove the old entry from your authenticator, then get a new QR code.");
  };
  update();
  state.enrollTimer = setInterval(update, 1000);
}

// "Use a backup code instead" -> switch the totp input to accept a backup code.
if ($("backup-link")) {
  $("backup-link").addEventListener("click", (ev) => {
    ev.preventDefault();
    if (state.stage !== "totp") return;
    state.useBackup = true;
    $("field-label").textContent = "Backup code";
    $("input").type = "text";
    $("input").autocomplete = "off";
    $("input").inputMode = "text";
    $("input").placeholder = "XXXXX-XXXXX";
    $("input").value = "";
    $("input").focus();
    setHidden("backup-link", true);
  });
}

async function refreshMe() {
  try {
    const res = await fetch(AUTH + "/me", { credentials: "same-origin" });
    if (res.status === 200) {
      const me = await res.json();
      if (me.role === "admin") setHidden("devices-link", false);
      setHidden("sessions-link", false);
      return me;
    }
  } catch { /* ignore: finishLogin continues without user role */ }
  return null;
}

// Client-side email shape check (UX only; the server is authoritative).
function validEmail(v) {
  if (typeof v !== "string") return false;
  const e = v.trim();
  if (e.length < 3 || e.length > 254) return false;
  return /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(e);
}

async function onSubmit(ev) {
  ev.preventDefault();
  if (state.inFlight || state.locked || enrollGated()) return;
  const needsInput = NEEDS_INPUT.has(state.stage);
  const value = needsInput ? normalizeCode($("input").value) : "";
  if (needsInput && !value) return;
  if (state.stage === "email" && !validEmail(value)) {
    showNote("error", "Enter a valid email address.");
    $("input").focus();
    return;
  }
  await guarded(async () => {
    switch (state.stage) {
      case "email":        await doRequest(value); break;
      case "otp":          await doCode(value); break;
      case "totp":         await doTotp(value); break;
      case "recovery":     await doTotp(value); break;
      case "totp_enroll":  await doTotpEnroll(value); break;
      case "backup_codes": await doAck(); break;
      case "ready":        await finishLogin(); break;
    }
  });
}

async function handleResult(status, data) {
  // 503 {retry:true}: server fault, nothing counted; keep the form usable.
  if (status === 503 && data && data.retry) {
    showNote("warn", "Something went wrong on our side. Nothing was counted. Try again.");
    return;
  }
  if (status === 429) { startLockCountdown(data && data.retry_after); return; }
  // 401: same neutral wording on every stage (anti-enumeration). The one
  // exception: recovery_available (3rd TOTP fail) reveals the backup-code step.
  if (status === 401) {
    if (data && data.recovery_available && state.stage === "totp") {
      state.stage = "recovery";
      render();
      showNote("error", "Invalid or expired code. You can use a backup code to reset your authenticator.");
      return;
    }
    showNote("error", "Invalid or expired code");
    return;
  }
  if (status === 0) {
    showNote("error", data && data.error ? data.error : "Unable to reach the server. Please try again.");
    return;
  }
  if (status >= 400) {
    showNote("error", "Sign-in is unavailable right now. Please try again shortly.");
    return;
  }
  showNote("", "");
  if (data && data.next) {
    if (data.next === "ready") { state.stage = "ready"; await finishLogin(); return; }
    state.stage = data.next;
    render();
  } else if (status === 200) {
    showNote("error", "Sign-in response was incomplete. Please try again.");
  }
}

async function doRequest(email) {
  const { status, data } = await api(AUTH + "/request", { email });
  if (status === 202) {
    state.stage = "otp";
    render();
    showNote("ok", "Your one-time code was sent successfully.");
    startResendCountdown(45);
  } else { await handleResult(status, data); }
}

async function doResend() {
  const { status, data } = await api(AUTH + "/resend", {});
  if (status === 202) { showNote("ok", "Your one-time code was sent successfully."); startResendCountdown(45); return; }
  if (status === 401) { showNote("error", "Login session expired. Enter your email again to get a new code."); return; }
  await handleResult(status, data);
}

async function doCode(code) {
  const { status, data } = await api(AUTH + "/code", { code });
  await handleResult(status, data);
}

// totp_enroll confirm: success returns the one-time backup codes -> ack step.
async function doTotpEnroll(code) {
  const { status, data } = await api(AUTH + "/totp", { code });
  if (status === 200) {
    hideEnrollBox();
    if (data && Array.isArray(data.backup_codes) && data.backup_codes.length > 0) {
      showBackupCodes(data.backup_codes);
      return;
    }
  }
  await handleResult(status, data);
}

async function doTotp(code) {
  if (state.stage === "recovery") {
    const { status, data } = await api(AUTH + "/recovery/backup-code", { code });
    if (status === 401 && data && typeof data.attempts_left === "number") {
      showNote("error", `Invalid or expired code (${data.attempts_left} attempt${data.attempts_left === 1 ? "" : "s"} left)`);
      return;
    }
    await handleResult(status, data);
    return;
  }
  const body = state.useBackup ? { backup_code: code } : { code };
  const { status, data } = await api(AUTH + "/totp", body);
  if (status === 200) {
    hideEnrollBox();
    if (data && Array.isArray(data.backup_codes) && data.backup_codes.length > 0) {
      showBackupCodes(data.backup_codes);
      return;
    }
  }
  await handleResult(status, data);
}

// backup_codes: ack the shown-once generation, then move to ready/session.
async function doAck() {
  const { status, data } = await api(AUTH + "/backup-codes/ack", {});
  await handleResult(status, data);
}

function showBackupCodes(codes) {
  hideEnrollBox();
  state.stage = "backup_codes";
  render();
  const box = $("note");
  box.className = "note once";
  box.innerHTML = "";
  const head = document.createElement("strong");
  head.textContent = "Save these backup codes now - shown once.";
  const grid = document.createElement("div");
  grid.className = "codes";
  codes.forEach((c) => { const s = document.createElement("span"); s.textContent = c; grid.appendChild(s); });
  const hint = document.createElement("div");
  hint.className = "qr-hint";
  hint.textContent = "Save them, then press Continue to finish signing in.";
  const ok = document.createElement("button");
  ok.type = "button"; ok.className = "ghost"; ok.textContent = "I saved them";
  ok.addEventListener("click", () => { guarded(doAck); });
  box.appendChild(head); box.appendChild(grid); box.appendChild(hint); box.appendChild(ok);
  box.hidden = false;
}

// Same-origin ?next= only (no "//" or absolute URLs): not an open redirect.
function safeNext() {
  try {
    const p = new URLSearchParams(window.location.search).get("next");
    if (!p || p[0] !== "/" || p[1] === "/" || p[1] === "\\") return null;
    return p;
  } catch { return null; }
}

async function finishLogin() {
  const { status, data } = await api(AUTH + "/session", {});
  if (status === 200) {
    const me = await refreshMe();
    state.stage = "done";
    setHidden("form", true);
    showNote("ok", "Signed in. Taking you to the admin console…");
    if (me && me.role === "admin") setHidden("devices-link", false);
    setHidden("sessions-link", false);
    const target = safeNext() || `${window.ADMIN_BASE_PATH || "/admin"}/`;
    window.setTimeout(() => { window.location.assign(target); }, 400);
  } else { await handleResult(status, data); }
}

function formatCountdown(secs) {
  secs = Math.max(0, Math.ceil(secs));
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  return `${secs}s`;
}

// Resend / lock countdown. Only touches the note while a LOCK is active, so it
// cannot wipe backup codes or error messages when a timer expires.
function tick() {
  const link = $("resend-link");
  const btn = $("submit");
  const remaining = (state.cooldownUntil - Date.now()) / 1000;

  if (remaining > 0) {
    const text = formatCountdown(remaining);
    if (state.locked) {
      showNote("error", `Wait! Please try again in ${text}`);
      btn.disabled = true;
    }
    if (link && !link.hidden) {
      link.textContent = `Resend code in ${text}`;
      link.setAttribute("aria-disabled", "1");
    }
    return;
  }

  if (state.locked) {
    state.locked = false;
    btn.disabled = false;
    showNote("", "");
  }
  if (link) {
    link.textContent = "Resend code";
    link.removeAttribute("aria-disabled");
  }
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}
function startResendCountdown(secs) {
  state.cooldownUntil = Date.now() + secs * 1000;
  if (!state.timer) state.timer = setInterval(tick, 500);
  tick();
}
function startLockCountdown(secs) {
  state.locked = true;
  state.cooldownUntil = Date.now() + (typeof secs === "number" ? secs : 60) * 1000;
  if (!state.timer) state.timer = setInterval(tick, 500);
  tick();
}

if ($("resend-link")) {
  $("resend-link").addEventListener("click", (ev) => {
    ev.preventDefault();
    if (Date.now() < state.cooldownUntil) return;
    guarded(doResend);
  });
}

// "Use this trusted device": the device path starts at the AUTHENTICATOR step,
// not the emailed-code step. Follow the server's `next`; the fallback is "totp".
// (The old code forced "otp", which sent the authenticator code to /auth/code,
// always rejected as "Invalid or expired code".)
if ($("device-link")) {
  $("device-link").addEventListener("click", async (ev) => {
    ev.preventDefault();
    const email = $("input").value.trim();
    if (!email) return;
    await guarded(async () => {
      const { status, data } = await api(AUTH + "/device/start", { email });
      if (status === 202) {
        state.stage = data && data.next ? data.next : "totp";
        state.strict = !!data && data.tier === "strict";
        showNote("", "");
        render();
      } else { await handleResult(status, data); }
    });
  });
}

$("form").addEventListener("submit", onSubmit);
render();
// Show the trusted-device option only if this browser holds an active device
// (checked against our own cookie; leaks nothing about a given email).
fetch(AUTH + "/device/available", { credentials: "same-origin" })
  .then((r) => (r.status === 200 ? r.json() : { available: false }))
  .then((j) => { if (j.available) { state.device = true; render(); } })
  .catch(() => {});