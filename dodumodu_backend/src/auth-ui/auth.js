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
  otp:            { label: "Code",            type: "text",     ac: "one-time-code",   btn: "Resend code", sub: "Enter the code we emailed you." },
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
      case "otp":          await doResend(); break;
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
  if (data && data.next) { state.stage = data.next; render(); }
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

async function finishLogin() {
  const { status, data } = await api(AUTH + "/session", {});
  if (status === 200) {
    const me = await refreshMe();
    state.stage = "done";
    $("form").hidden = true;
    showNote("ok", "Signed in.");
    if (me && me.role === "admin") $("devices-link").hidden = false;
    $("sessions-link").hidden = false;
  } else { await handleResult(status, data); }
}

function tick() {
  const now = Date.now();
  const btn = $("submit");
  if (state.cooldownUntil > now) {
    const secs = Math.ceil((state.cooldownUntil - now) / 1000);
    btn.disabled = true;
    btn.textContent = state.stage === "otp" ? `Resend in ${secs}s` : `Wait ${secs}s`;
  } else {
    clearInterval(state.timer); state.timer = null;
    btn.disabled = false;
    if (state.stage === "otp") btn.textContent = "Resend code";
  }
}
function startResendCountdown(secs) { state.cooldownUntil = Date.now() + secs * 1000; if (!state.timer) state.timer = setInterval(tick, 500); tick(); }
function startLockCountdown(secs) {
  state.cooldownUntil = Date.now() + (typeof secs === "number" ? secs : 60) * 1000;
  if (!state.timer) state.timer = setInterval(tick, 500); tick();
}

$("form").addEventListener("submit", onSubmit);
render();

