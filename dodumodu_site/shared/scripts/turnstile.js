// The bot check (Cloudflare Turnstile), built so a customer never waits for it and never sees it unless Cloudflare
// itself needs a tap.
//
// WHEN IT LOADS. On intent, not at page load: when the order form is about two screens away, when a field is touched,
// or when an order button jumps to the form. Loading it with the page made small Android phones laggy while the hero and
// the first scroll were still happening; filling the form takes the customer long enough for the solve to finish first.
//
// WHAT THE CUSTOMER SEES. Nothing (`appearance: interaction-only`): the challenge runs invisibly and the box appears only
// if Cloudflare decides it needs a tap. The container is never display:none (a hidden iframe can stall the solve); it is
// collapsed to zero height until a tap is actually needed.
//
// TOKENS. A token is valid for 5 minutes and works once. So: a token older than 4.5 minutes is dropped and re-solved in
// the background, a token the server spent (any answered order attempt) is dropped by resetTurnstile() so the next click
// has a fresh one waiting, and Cloudflare is told to refresh an expired token on its own.
//
// SLOW LINKS. The script load is retried, the wait at "Place order" is 45s (not 10s) with an honest message from the page,
// and the order is never posted with a token that cannot verify.
//
// No site key means the challenge is not configured for this build (local development, where the server skips
// verification too): nothing is requested and ensureToken() resolves at once.
const ORIGIN = "https://challenges.cloudflare.com";
const API_SRC = `${ORIGIN}/turnstile/v0/api.js?render=explicit&onload=__turnstileLoaded`;
const WAIT_MS = 45_000;
const TOKEN_FRESH_MS = 270_000;
const LOAD_RETRIES = 2;
// How soon a failed solve is started over. Cloudflare's own default is 8s; on a slow link that is most of the wait.
const RESTART_AFTER_ERROR_MS = 1200;
// A solve that has produced neither a token nor an error for this long is treated as stalled and restarted. Long on
// purpose: on a very slow link a working solve can take a while, and restarting it early would throw that progress away.
const STALL_MS = 20_000;

let state = "idle"; // idle -> loading -> ready | failed
let widgetId = null;
let issuedAt = 0;
let loadAttempts = 0;
let armed = false;
let solveAt = 0; // when the current solve began, so a stalled one can be restarted
let waiters = []; // [{ resolve, reject, timer }]
let errors = 0; // transient widget errors in a row since the last token
let interacted = false; // the customer was shown the tap box, so a failure afterwards must be visible to them
let restartTimer = null;
let tapRestart = false; // a whole round of waiting failed: the next tap on Place order starts the solve over
let watchdog = null;
let tokenListeners = [];

const hostEl = () => document.getElementById("cf-turnstile");
const inputEl = () => document.querySelector('input[name="turnstileToken"]');

function turnstileConfigured() {
  return Boolean(hostEl()?.dataset.sitekey);
}

function settle(error) {
  const list = waiters;
  waiters = [];
  for (const w of list) {
    clearTimeout(w.timer);
    if (error) w.reject(error);
    else w.resolve();
  }
}

function tokenIsFresh() {
  const value = inputEl()?.value;
  return Boolean(value) && Date.now() - issuedAt < TOKEN_FRESH_MS;
}

function clearToken() {
  const input = inputEl();
  if (input) input.value = "";
  issuedAt = 0;
}

const showBox = (visible) => { const h = hostEl(); if (h) h.dataset.ready = String(visible); };

/**
 * Starts the solve over. A plain reset() is enough for a stalled or errored solve; if the widget cannot be reset (or has
 * kept failing) it is torn down and drawn again from scratch, and if the script itself never arrived it is requested again.
 */
function restartSolve(hard = false) {
  clearTimeout(restartTimer);
  restartTimer = null;
  clearToken();
  solveAt = Date.now();
  if (state === "failed") return void arm();
  if (widgetId === null || !window.turnstile) return;
  try {
    if (hard && typeof window.turnstile.remove === "function") {
      window.turnstile.remove(widgetId);
      widgetId = null;
      renderWidget();
    } else {
      window.turnstile.reset(widgetId);
    }
  } catch {
    // reset() threw (widget half-built): draw a fresh one
    try { widgetId = null; renderWidget(); } catch { /* the next wake or tap tries again */ }
  }
}

// After an error: start over soon, and back off if Cloudflare keeps failing so a bad network is not hammered.
function scheduleRestart() {
  if (restartTimer) return;
  const delay = errors > 6 ? 8000 : errors > 3 ? 3000 : RESTART_AFTER_ERROR_MS;
  restartTimer = setTimeout(() => { restartTimer = null; restartSolve(errors % 3 === 0); }, delay);
}

// While a customer waits on the check, notice a solve that has gone quiet and start it over.
function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (!waiters.length) { clearInterval(watchdog); watchdog = null; return; }
    if (!tokenIsFresh() && Date.now() - solveAt > STALL_MS) restartSolve(false);
  }, 3000);
}

function renderWidget() {
  const host = hostEl();
  if (!host || !window.turnstile || widgetId !== null) return;
  solveAt = Date.now();
  widgetId = window.turnstile.render(host, {
    sitekey: host.dataset.sitekey,
    appearance: "interaction-only",
    retry: "auto",
    "retry-interval": 2500,
    "refresh-expired": "auto",
    callback(token) {
      const input = inputEl();
      if (input) input.value = token;
      issuedAt = Date.now();
      errors = 0;
      interacted = false;
      tapRestart = false;
      clearTimeout(restartTimer);
      restartTimer = null;
      showBox(false);
      settle(null);
      const list = tokenListeners;
      tokenListeners = [];
      for (const fn of list) { try { fn(token); } catch { /* a listener must never break the solve */ } }
    },
    // A configuration problem (bad/disabled site key, hostname not allowed) can never fix itself: say so at once
    // instead of waiting out the clock.
    "error-callback"(code) {
      if (/^(110[0-9]{3}|4000[0-9]{2})$/.test(String(code))) {
        state = "failed";
        const err = new Error(`Challenge is not set up for this site (${code})`);
        err.code = "turnstile_config";
        settle(err);
        return true;
      }
      // Transient (a dropped connection, a challenge that failed). Never leave the customer with a silent, invisible
      // widget: if they are waiting, or had just tapped the box, show it (so Cloudflare's own message and Retry are
      // reachable), and start the solve over without waiting out Cloudflare's slower retry.
      errors += 1;
      clearToken();
      if (waiters.length || interacted) showBox(true);
      scheduleRestart();
      return false;
    },
    "unsupported-callback"() {
      state = "failed";
      const err = new Error("This browser cannot run the challenge");
      err.code = "turnstile_config";
      settle(err);
      return true;
    },
    // The tap-to-verify box timed out unanswered: start over instead of leaving a dead box behind.
    "timeout-callback"() { restartSolve(false); },
    "expired-callback": clearToken, // Cloudflare retries errors itself (retry: auto); WAIT_MS is the only give-up
    // The challenge needs a tap: show the box, and if someone is already waiting, bring it into view.
    "before-interactive-callback"() {
      interacted = true;
      showBox(true);
      if (waiters.length) hostEl()?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    },
    "after-interactive-callback"() { showBox(false); },
  });
}

function loadScript() {
  loadAttempts += 1;
  state = "loading";
  // `onload` fires once api.js has defined window.turnstile, so render straight away. turnstile.ready() must NOT be used
  // here: it never calls back for a script that was added with async/defer, so the widget was never created and the
  // customer waited the full timeout at "Place order" with nothing ever loading.
  window.__turnstileLoaded = () => {
    state = "ready";
    try { renderWidget(); } catch (e) { state = "failed"; settle(new Error("Challenge could not start")); }
  };
  const script = document.createElement("script");
  script.src = API_SRC;
  script.async = true;
  script.defer = true;
  script.fetchPriority = "low"; // never compete with the photo or the page script
  script.onerror = () => {
    script.remove?.();
    if (loadAttempts <= LOAD_RETRIES) return void setTimeout(loadScript, 1500 * loadAttempts); // dropped mobile data
    state = "failed";
    settle(new Error("Challenge could not load"));
  };
  document.head.appendChild(script);
}

function arm() {
  if (!turnstileConfigured()) return;
  if (state === "failed") { state = "idle"; loadAttempts = 0; } // a later click gets a fresh try
  if (state !== "idle") return;
  loadScript();
}

const whenIdle = (fn) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 300);
};

// A phone that lost signal, slept, or came back to this tab must not be left holding a failed or stalled check.
function wake() {
  if (!turnstileConfigured() || document.visibilityState === "hidden") return;
  if (state === "failed") return void arm();
  if (widgetId !== null && !tokenIsFresh() && (errors > 0 || Date.now() - solveAt > STALL_MS)) restartSolve(errors > 2);
}

export function armTurnstile(formEl) {
  if (armed) return;
  if (!turnstileConfigured()) return; // no challenge in this build, nothing to arm
  armed = true;

  // The solve is real work (an iframe, crypto, network). Running it while a phone is still loading and scrolling the
  // top of the page made the whole page feel heavy, so it starts on INTENT instead of at load, and still well before
  // the button: the customer needs 10+ seconds to fill the form.
  let io = null;
  const go = () => {
    io?.disconnect();
    for (const ev of ["focusin", "pointerdown"]) formEl?.removeEventListener?.(ev, go);
    document.removeEventListener?.("click", onAnchor, true);
    arm();
  };
  // 1. The customer touches the form.
  for (const ev of ["focusin", "pointerdown"]) formEl?.addEventListener?.(ev, go, { once: true, passive: true });
  // 2. The form is about to come into view (about two screens away).
  if (formEl && typeof IntersectionObserver === "function") {
    io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) go(); }, { rootMargin: "1200px 0px" });
    io.observe(formEl);
  } else {
    whenIdle(arm); // no observer support: fall back to after-load idle
  }
  // 3. They jump straight to the form from an order button.
  function onAnchor(e) {
    const a = e.target?.closest?.('a[href^="#order"]');
    if (a) go();
  }
  document.addEventListener?.("click", onAnchor, true);
  // 4. Safety nets, so the check is never first requested by the Place order tap itself (the slowest moment for it):
  //    - the moment the customer first scrolls or touches the page, only the CONNECTION to Cloudflare is opened (DNS and
  //      TLS are most of the wait on a slow link, and this costs the page next to nothing);
  //    - and if nothing above has started it a few seconds after the page settled, it starts anyway.
  const warm = () => {
    const link = Object.assign(document.createElement("link"), { rel: "preconnect", href: ORIGIN });
    document.head.appendChild(link);
  };
  for (const ev of ["scroll", "pointerdown"]) window.addEventListener?.(ev, warm, { once: true, passive: true });
  const late = () => setTimeout(go, 8000);
  if (document.readyState === "complete") late(); else window.addEventListener?.("load", late, { once: true });
  window.addEventListener?.("online", wake);
  document.addEventListener?.("visibilitychange", wake);
}

/**
 * Resolves when a fresh, unspent token is in the form; rejects if there is none after WAIT_MS or the challenge cannot
 * load. Normally the token has been there for a while and this returns at once.
 */
export function ensureToken(ms = WAIT_MS) {
  if (!turnstileConfigured()) return Promise.resolve();
  if (tokenIsFresh()) return Promise.resolve();

  // A token that is present but old would be refused by the server: re-solve it instead of sending it.
  if (inputEl()?.value) {
    clearToken();
    if (widgetId !== null) try { window.turnstile.reset(widgetId); } catch { /* still loading */ }
  }
  arm();
  if (state === "failed") return Promise.reject(new Error("Challenge could not load"));
  // The customer needs a token NOW. A solve that errored, or has been quiet for a while, will not get there by itself in
  // time: start it over at this moment (the tap on Place order) instead of letting them repeat the same wait.
  if (widgetId !== null && (tapRestart || errors > 0 || Date.now() - solveAt > STALL_MS)) {
    const hard = tapRestart || errors > 2;
    tapRestart = false;
    restartSolve(hard);
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    waiter.timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== waiter);
      reject(new Error("Challenge timed out"));
    }, ms);
    waiters.push(waiter);
    startWatchdog();
  });
}

/**
 * A whole round of waiting ended without a token. Start the solve over now, from scratch, so a fresh attempt is already
 * running (and may even have finished) while the customer reads "tap once more"; and start over again at that tap if there
 * is still no token, because that tap is the customer explicitly trying again.
 */
export function checkFailed() {
  tapRestart = true;
  restartSolve(true);
}

/**
 * Calls `fn(token)` once, the next time a token arrives, even if nobody is waiting at that moment. Used to finish an
 * order that was recorded while the check was still running. Returns a function that cancels it.
 */
export function onNextToken(fn) {
  tokenListeners.push(fn);
  return () => { tokenListeners = tokenListeners.filter((f) => f !== fn); };
}

/** The token if it is there (or arrives within `ms`), else "". Never rejects: the order goes either way. */
export const quickToken = (ms) => ensureToken(ms).then(() => inputEl()?.value || "", () => "");

/** True when a token is (or becomes, within `ms`) available. Used to upgrade an order that went through without one. */
export const waitForToken = (ms) => ensureToken(ms).then(() => Boolean(inputEl()?.value), () => false);

/**
 * Drops a token that has been (or may have been) spent and starts solving a new one in the background, so the next
 * click already has one. Called after any answered order attempt, and when a page comes back from the back/forward cache.
 *
 * Turnstile tokens are single-use. A token the server has seen must never be sent again: it can only fail, and the
 * customer would be told the bot check failed for an order that was fine.
 */
export function resetTurnstile() {
  clearToken();
  if (widgetId !== null && window.turnstile) {
    try { window.turnstile.reset(widgetId); } catch { /* the widget is still loading: nothing to reset */ }
  }
  // Anyone parked on the old token can never be satisfied by it.
  settle(new Error("Challenge was reset"));
}
