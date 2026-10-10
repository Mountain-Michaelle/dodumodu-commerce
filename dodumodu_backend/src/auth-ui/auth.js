/* admin-auth v2 UI — vanilla JS, external file (CSP: script-src 'self').
 * One input per stage, rendered from the server's `next`. No tokens in
 * localStorage. Neutral errors; 429 shows a server countdown; 503 keeps the
 * form usable ("nothing was counted"). Disables submit while in flight.
 */
"use strict";

const AUTH = "/auth";
const $ = (id) => document.getElementById(id);

const state = {
  stage: "email",      // email | otp | phrase | enroll_phrase | totp | totp_enroll | ready | done
  device: false,
  strict: false,
  showBackup: true,
  cooldownUntil: 0,
  timer: null,
};

function showNote(kind, text) {
  const n = $("note");
  n.className = "note " + kind;
  n.textContent = text;
  n.hidden = !text;
}
function setHint(text) { const h = $("hint"); h.textContent = text || ""; h.hidden = !text; }
function busy(b) { $("submit").disabled = b; }

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

const STAGES = {
  email:          { label: "Email",           type: "email",    ac: "username",        btn: "Continue", sub: "Enter your email to receive a one-time code." },
  otp:            { label: "Code",            type: "text",     ac: "one-time-code",   btn: "Verify",   sub: "Enter the code we emailed you." },
  phrase:         { label: "Sign-in phrase",  type: "password", ac: "current-password",btn: "Continue", sub: "Enter your sign-in phrase." },
  enroll_phrase:  { label: "Choose a phrase", type: "password", ac: "new-password",    btn: "Continue", sub: "Choose a sign-in phrase (12-64 characters, no spaces)." },
  totp:           { label: "Authenticator",   type: "text",     ac: "one-time-code",   btn: "Verify",   sub: "Enter the 6-digit code from your authenticator app." },
  totp_enroll:    { label: "Authenticator",   type: "text",     ac: "one-time-code",   btn: "Verify",   sub: "Enter the 6-digit code from your authenticator app." },
};

function render() {
  const cfg = STAGES[state.stage];
  if (!cfg) { $("form").hidden = true; return; }
  $("form").hidden = false;
  state.useBackup = false;
  $("field-label").textContent = cfg.label;
  const input = $("input");
  input.type = cfg.type;
  input.autocomplete = cfg.ac;
  input.value = "";
  input.focus();
  $("submit").textContent = cfg.btn;
  $("subtitle").textContent = cfg.sub;
  if (state.strict && (state.stage === "totp" || state.stage === "phrase")) {
    setHint("Extra checks are on because your network changed.");
  } else { setHint(""); }
  const backup = $("backup-link");
  if (backup) backup.hidden = !(state.stage === "totp" && state.showBackup && !state.strict);
  const resend = $("resend-link");
  if (resend) { resend.hidden = state.stage !== "otp"; tick(); }
  const dev = $("device-link");
  if (dev) dev.hidden = !(state.stage === "email" && state.device);
  // First time at totp_enroll: fetch the pending secret and show it ONCE.
  if (state.stage === "totp_enroll" && !state.enrollStarted) {
    state.enrollStarted = true;
    enrollStart();
  }
}

// totp_enroll: POST /auth/totp/enroll/start, render secret + otpauth link once.
async function enrollStart() {
  const res = await fetch(AUTH + "/totp/enroll/start", {
    method: "POST", headers: { "Content-Type": "application/json" },
    credentials: "same-origin", body: "{}",
  });
  if (res.status !== 200) { showNote("error", "Invalid or expired code"); return; }
  const { secret, otpauth_uri } = await res.json();
  const box = $("enroll-box");
  box.innerHTML = "";
  const head = document.createElement("strong");
  head.textContent = "Add this to your authenticator app (shown once).";
  const code = document.createElement("div");
  code.className = "mono"; code.textContent = secret;
  const uri = document.createElement("a");
  uri.href = otpauth_uri; uri.textContent = "Open in authenticator"; uri.rel = "noopener";
  const ok = document.createElement("button");
  ok.type = "button"; ok.className = "ghost"; ok.textContent = "I saved it";
  ok.addEventListener("click", () => { box.hidden = true; $("input").focus(); });
  box.appendChild(head); box.appendChild(code); box.appendChild(uri); box.appendChild(ok);
  box.hidden = false;
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
    $("input").placeholder = "XXXXX-XXXXX";
    $("input").value = "";
    $("input").focus();
    $("backup-link").hidden = true;
  });
}

async function refreshMe() {
  const res = await fetch(AUTH + "/me", { credentials: "same-origin" });
  if (res.status === 200) {
    const me = await res.json();
    if (me.role === "admin") $("devices-link").hidden = false;
    $("sessions-link").hidden = false;
    return me;
  }
  return null;
}

async function onSubmit(ev) {
  ev.preventDefault();
  const value = $("input").value.trim();
  if (!value) return;
  busy(true);
  try {
    switch (state.stage) {
      case "email":        await doRequest(value); break;
      case "otp":          await doCode(value); break;
      case "phrase":       await doPhrase(value); break;
      case "enroll_phrase":await doEnroll(value); break;
      case "totp":
      case "totp_enroll":  await doTotp(value); break;
    }
  } finally {
    busy(false);
  }
}

async function handleResult(status, data) {
  // 503 {retry:true}: server fault, nothing counted — keep the form usable.
  if (status === 503 && data && data.retry) {
    showNote("warn", "Something went wrong on our side. Nothing was counted. Try again.");
    return;
  }
  // 429: lock — show a server-driven countdown and disable the form.
  if (status === 429) {
    showNote("error", "Too many attempts. Please wait.");
    startLockCountdown(data && data.retry_after);
    return;
  }
  if (status >= 400) {
    showNote("error", "Invalid or expired code"); // same neutral error everywhere
    return;
  }
  showNote("");
  if (data && data.next) {
    if (data.next === "ready") { state.stage = "ready"; await finishLogin(); return; }
    state.stage = data.next;
    render();
  }
}

async function doRequest(email) {
  const { status, data } = await api(AUTH + "/request", { email });
  if (status === 202) {
    state.stage = "otp";
    showNote("ok", "If this email is registered, check your inbox.");
    render();
    startResendCountdown(45);
  } else { await handleResult(status, data); }
}

async function doResend() {
  const { status, data } = await api(AUTH + "/resend", {});
  if (status === 202) { showNote("ok", "If this email is registered, check your inbox."); startResendCountdown(45); }
  else { await handleResult(status, data); }
}

async function doCode(code) {
  const { status, data } = await api(AUTH + "/code", { code });
  await handleResult(status, data);
}

async function doPhrase(phrase) {
  const { status, data } = await api(AUTH + "/phrase", { phrase });
  await handleResult(status, data);
}

async function doEnroll(phrase) {
  const { status, data } = await api(AUTH + "/phrase/enroll", { phrase, confirm: phrase });
  await handleResult(status, data);
}

async function doTotp(code) {
  const body = state.useBackup ? { backup_code: code } : { code };
  const { status, data } = await api(AUTH + "/totp", body);
  if (status === 200 && data && data.backup_codes) { showBackupCodes(data.backup_codes); return; }
  await handleResult(status, data);
}

function showBackupCodes(codes) {
  const box = $("note");
  box.className = "note once";
  box.innerHTML = "";
  const head = document.createElement("strong");
  head.textContent = "Save these backup codes now - shown once.";
  const grid = document.createElement("div");
  grid.className = "codes";
  codes.forEach((c) => { const s = document.createElement("span"); s.textContent = c; grid.appendChild(s); });
  const ok = document.createElement("button");
  ok.type = "button"; ok.className = "ghost"; ok.textContent = "I saved them";
  ok.addEventListener("click", () => { box.hidden = true; finishLogin(); });
  box.appendChild(head); box.appendChild(grid); box.appendChild(ok);
  box.hidden = false;
}

// Same-origin ?next= only: a leading single "/" is required and "//" (protocol
// relative) and absolute URLs are refused, so this cannot be used as an open
// redirect (§11 web attack: open redirects).
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
    $("form").hidden = true;
    showNote("ok", "Signed in. Taking you to the admin console…");
    if (me && me.role === "admin") $("devices-link").hidden = false;
    $("sessions-link").hidden = false;
    // Land on the main admin page (/admin/). The session cookie is same-origin,
    // so it rides along. Honor a validated ?next= if one was supplied.
    const target = safeNext() || "/admin/";
    window.setTimeout(() => { window.location.assign(target); }, 400);
  } else { await handleResult(status, data); }
}

function tick() {
  const now = Date.now();
  const link = $("resend-link");
  const btn = $("submit");
  if (state.cooldownUntil > now) {
    const secs = Math.ceil((state.cooldownUntil - now) / 1000);
    // A lock disables the whole form; a resend cooldown only greys the link.
    if (state.locked) btn.disabled = true;
    if (link && !link.hidden) { link.textContent = `Resend code in ${secs}s`; link.setAttribute("aria-disabled", "1"); }
  } else {
    if (state.locked) { state.locked = false; btn.disabled = false; }
    if (link) { link.textContent = "Resend code"; link.removeAttribute("aria-disabled"); }
    if (!state.timer) return;
    clearInterval(state.timer); state.timer = null;
  }
}
function startResendCountdown(secs) { state.cooldownUntil = Date.now() + secs * 1000; if (!state.timer) state.timer = setInterval(tick, 500); tick(); }
function startLockCountdown(secs) {
  state.locked = true;
  state.cooldownUntil = Date.now() + (typeof secs === "number" ? secs : 60) * 1000;
  if (!state.timer) state.timer = setInterval(tick, 500); tick();
}

// Resend link (only visible at the otp stage, during/after its cooldown).
if ($("resend-link")) {
  $("resend-link").addEventListener("click", (ev) => {
    ev.preventDefault();
    if (Date.now() < state.cooldownUntil) return;
    doResend();
  });
}

// "Use this trusted device" -> the device path (phrase -> TOTP -> session).
if ($("device-link")) {
  $("device-link").addEventListener("click", async (ev) => {
    ev.preventDefault();
    const email = $("input").value.trim();
    if (!email) return;
    busy(true);
    try {
      const { status, data } = await api(AUTH + "/device/start", { email });
      if (status === 202) {
        state.stage = "phrase";
        showNote("");
        render();
      } else { await handleResult(status, data); }
    } finally { busy(false); }
  });
}

$("form").addEventListener("submit", onSubmit);
render();
// Show the trusted-device option only if this browser actually holds an active
// device (checked against our own cookie; leaks nothing about a given email).
fetch(AUTH + "/device/available", { credentials: "same-origin" })
  .then((r) => (r.status === 200 ? r.json() : { available: false }))
  .then((j) => { if (j.available) { state.device = true; render(); } })
  .catch(() => {});

