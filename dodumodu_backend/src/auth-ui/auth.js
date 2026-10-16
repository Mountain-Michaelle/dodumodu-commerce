/* admin-auth v2 UI — vanilla JS, external file (CSP: script-src 'self').
 * One input per stage, rendered from the server's `next`. No tokens in
 * localStorage. Neutral errors; 429 shows a server countdown; 503 keeps the
 * form usable ("nothing was counted"). Disables submit while in flight.
 */
import { makeQrSvg } from "./qr-logo.mjs";

const AUTH = "/auth";
const $ = (id) => document.getElementById(id);

const state = {
  stage: "email",      // email | otp | enroll_phrase | totp | totp_enroll | backup_codes | ready | done
  device: false,
  strict: false,
  showBackup: true,
  useBackup: false,
  locked: false,
  enrollStarted: false, // totp_enroll secret fetched once per visit
  cooldownUntil: 0,
  timer: null,
  qrRefreshTimer: null,
  qrExpiresAt: 0,
  inFlight: false,     // prevents double-submit races on code/phrase/TOTP entry
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
  enroll_phrase:  { label: "Choose a phrase", type: "password", ac: "new-password",    btn: "Continue", sub: "Choose a sign-in phrase (12-64 characters, no spaces)." },
  totp:           { label: "Authenticator",   type: "text",     ac: "one-time-code",   btn: "Verify",   sub: "Enter the 6-digit code from your authenticator app." },
  totp_enroll:    { label: "Authenticator",   type: "text",     ac: "one-time-code",   btn: "Verify",   sub: "Enter the 6-digit code from your authenticator app." },
  backup_codes:   { label: "Ready",           type: "text",     ac: "off",             btn: "Continue", sub: "Backup codes saved. Continue to finish signing in." },
  ready:          { label: "Ready",           type: "text",     ac: "off",             btn: "Sign in",  sub: "All checks passed. Continue to sign in." },
};

function stopQrRefresh() {
  if (state.qrRefreshTimer) { clearInterval(state.qrRefreshTimer); state.qrRefreshTimer = null; }
}
function hideEnrollBox() {
  const box = $("enroll-box");
  if (box) { box.hidden = true; box.innerHTML = ""; }
}

function render() {
  const cfg = STAGES[state.stage];
  if (!cfg) { stopQrRefresh(); hideEnrollBox(); $("form").hidden = true; return; }
  // Leaving totp_enroll: stop QR polling + clear the enroll box; returning
  // resets the flag so the pending secret is fetched fresh again.
  if (state.stage !== "totp_enroll") {
    stopQrRefresh();
    hideEnrollBox();
    state.enrollStarted = false;
  }
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
  if (state.strict && state.stage === "totp") {
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

// totp_enroll: POST /auth/totp/enroll/start, render QR code + setup key once.
// QR auto-refreshes every 60s (each refresh invalidates the previous secret).
async function enrollStart() {
  const res = await fetch(AUTH + "/totp/enroll/start", {
    method: "POST", headers: { "Content-Type": "application/json" },
    credentials: "same-origin", body: "{}",
  });
  if (res.status !== 200) { showNote("error", "Invalid or expired code"); return; }
  const { secret, otpauth_uri } = await res.json();
  const box = $("enroll-box");
  box.innerHTML = "";

  // Heading
  const head = document.createElement("strong");
  head.textContent = "Scan with your authenticator app (shown once).";
  box.appendChild(head);

  // QR code
  const qrSvg = makeQrSvg(otpauth_uri, { size: 220, margin: 20, ecc: "H" });
  const qrImg = document.createElement("img");
  qrImg.src = "data:image/svg+xml;base64," + btoa(qrSvg);
  qrImg.alt = "TOTP enrolment QR code";
  qrImg.className = "";
  const qrPanel = document.createElement("div");
  qrPanel.className = "qr-panel";
  qrPanel.appendChild(qrImg);
  box.appendChild(qrPanel);

  // Manual setup key
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

  // Hint
  const hint = document.createElement("div");
  hint.className = "qr-hint";
  hint.textContent = "Scan with your authenticator app. The QR refreshes every 2 minutes.";
  box.appendChild(hint);

  // "I saved it" button — just focus the input, keep QR visible so the user
  // can retry if verification fails. The box is hidden on successful verify.
  const ok = document.createElement("button");
  ok.type = "button"; ok.className = "ghost"; ok.textContent = "I saved it";
  ok.addEventListener("click", () => { $("input").focus(); });
  box.appendChild(ok);

  box.hidden = false;

  // Auto-refresh QR every 2 minutes (silently, no user-visible countdown).
// Only refreshes when the current secret has expired.
  state.qrExpiresAt = Date.now() + 120000;
  if (state.qrRefreshTimer) clearInterval(state.qrRefreshTimer);
  state.qrRefreshTimer = setInterval(async () => {
    // Skip refresh while the current secret is still valid (2 minutes).
    if (Date.now() < state.qrExpiresAt) return;
    // Re-fetch a new secret (invalidates the previous one)
    try {
      const r2 = await fetch(AUTH + "/totp/enroll/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin", body: "{}",
      });
      if (r2.status !== 200) { return; }
      const { secret: newSecret, otpauth_uri: newUri } = await r2.json();
      qrImg.src = "data:image/svg+xml;base64," + btoa(makeQrSvg(newUri, { size: 220, margin: 20, ecc: "H" }));
      keyText.textContent = newSecret;
      state.qrExpiresAt = Date.now() + 120000;
    } catch { /* silent failure — retry next tick */ }
  }, 2000);
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

// Pragmatic client-side email shape check (UX only — the server's normalizeEmail
// is authoritative). Mirrors the backend rules closely enough to catch typos
// before a round trip: one "@", dot-atom local part, dotted domain, >=2-letter TLD.
function validEmail(v) {
  if (typeof v !== "string") return false;
  const e = v.trim();
  if (e.length < 3 || e.length > 254) return false;
  return /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(e);
}

async function onSubmit(ev) {
  ev.preventDefault();
  const value = $("input").value.trim();
  if (!value) return;
  if (state.inFlight) return; // ignore double-submit while a request is in flight
  // The email stage validates the shape locally and never sends a malformed
  // address. A clear message here beats a silent round trip.
  if (state.stage === "email" && !validEmail(value)) {
    showNote("error", "Enter a valid email address.");
    $("input").focus();
    return;
  }
  state.inFlight = true;
  busy(true);
  try {
    switch (state.stage) {
      case "email":        await doRequest(value); break;
      case "otp":          await doCode(value); break;
      case "enroll_phrase":await doEnroll(value); break;
      case "backup_codes": await doAck(value); break;
      case "ready":        await finishLogin(); break;
      case "totp":
      case "totp_enroll":  await doTotp(value); break;
    }
  } finally {
    state.inFlight = false;
    busy(false);
  }
}

async function handleResult(status, data) {
  // 503 {retry:true}: server fault, nothing counted — keep the form usable.
  if (status === 503 && data && data.retry) {
    showNote("warn", "Something went wrong on our side. Nothing was counted. Try again.");
    return;
  }
  // 429: lock — live countdown on the note (red) and the disabled submit button.
  if (status === 429) {
    startLockCountdown(data && data.retry_after);
    return;
  }
  // 401: the input the user just typed was rejected (expired code, wrong phrase,
  // wrong TOTP/backup). Same neutral wording on every stage so the stages cannot
  // be told apart (anti-enumeration).
  if (status === 401) {
    showNote("error", "Invalid or expired code");
    return;
  }
  // Anything else (404 feature-disabled / not found, 5xx, other 4xx) is a server or
  // configuration fault — never the user's input. Say so neutrally and never blame
  // the code/passphrase/email the user typed. The email stage must never mention
  // "code" in any message.
  if (status >= 400) {
    showNote("error", "Sign-in is unavailable right now. Please try again shortly.");
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
  if (status === 202) { showNote("ok", "If this email is registered, check your inbox."); startResendCountdown(45); return; }
  // 401 on resend = the flow cookie/session expired (or no valid flow), not a wrong code.
  if (status === 401) { showNote("error", "Login session expired. Enter your email again to get a new code."); return; }
  await handleResult(status, data);
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
  if (status === 200 && data && Array.isArray(data.backup_codes) && data.backup_codes.length > 0) {
    showBackupCodes(data.backup_codes);
    return;
  }
  await handleResult(status, data);
}

async function doTotp(code) {
  const body = state.useBackup ? { backup_code: code } : { code };
  const { status, data } = await api(AUTH + "/totp", body);
  // 200 from totp_enroll confirm may already carry the one-time backup codes.
  // Show them with an explicit ack step; every other outcome flows through
  // handleResult so success, wrong-code, lock, and faults all give feedback.
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
  stopQrRefresh();
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
  // Explicit ack: the server gates the session until the shown-once set is
  // acknowledged. Pressing Continue without acking now tells the user.
  ok.addEventListener("click", () => { doAck(); });
  box.appendChild(head); box.appendChild(grid); box.appendChild(hint); box.appendChild(ok);
  box.hidden = false;
  $("input").focus();
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

function formatCountdown(secs) {
  secs = Math.max(0, Math.ceil(secs));
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  return `${secs}s`;
}

function btnLabel() {
  return (STAGES[state.stage] && STAGES[state.stage].btn) || "Continue";
}

function tick() {
  const now = Date.now();
  const link = $("resend-link");
  const btn = $("submit");
  const note = $("note");
  if (state.cooldownUntil > now) {
    const secs = Math.ceil((state.cooldownUntil - now) / 1000);
    const text = formatCountdown(secs);
    const msg = `Wait! Please try again in ${text}`;
    // Live countdown on the note (red/error styling) while locked.
    if (state.locked && note) {
      note.className = "note error";
      note.textContent = msg;
      note.hidden = false;
    }
    // Disabled button keeps its default text — it cannot be bypassed,
    // only the note/links communicate the wait time.
    if (state.locked) btn.disabled = true;
    if (link && !link.hidden) {
      link.textContent = `Resend code in ${text}`;
      link.setAttribute("aria-disabled", "1");
    }
  } else {
    if (state.locked) {
      state.locked = false;
      btn.disabled = false;
      btn.textContent = btnLabel();
    }
    if (link) {
      link.textContent = "Resend code";
      link.removeAttribute("aria-disabled");
    }
    // Clear the countdown note once the lock expires.
    if (note) { note.hidden = true; note.textContent = ""; }
    if (!state.timer) return;
    clearInterval(state.timer);
    state.timer = null;
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
        state.stage = "enroll_phrase";
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

