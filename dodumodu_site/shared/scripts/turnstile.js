// The bot check (Cloudflare Turnstile), built so it can never get in the customer's way.
//
// WHEN IT LOADS. Only on genuine interaction with the order form: typing in, selecting, or changing a field (and the
// moment Place order is tapped, if it has not started yet). NOT on page load, reload, scrolling, idle, a timer, or the
// form merely coming into view. Nothing here registers a scroll/timer/observer before that first interaction: until then
// this module costs the page nothing and makes no request to Cloudflare. It starts once per verification lifecycle.
//
// IT NEVER COMPETES WITH TYPING. Starting after the first keystroke must not cost the customer a single keystroke, so
// the work is split into two small steps (inject the script; draw the widget), each run only once the customer has paused
// typing for QUIET_MS and the browser is idle (requestIdleCallback). The script is async + low priority. If the customer
// presses Place order first, the steps run at once. And if the challenge's frame still grabs keyboard focus (Cloudflare's
// iframe can), focus is handed straight back to the field they were typing in, unless they deliberately tapped the box.
//
// WHAT THE CUSTOMER SEES. Nothing (`appearance: interaction-only`): the challenge runs invisibly and the box appears only
// if Cloudflare decides it needs a tap. The container sits directly ABOVE the Place order button and grows downward only
// (the page's scroll anchoring is off, so nothing above it moves and the page does not scroll). It is never display:none
// (a hidden iframe can stall the solve).
//
// IT NEVER DECIDES WHETHER AN ORDER IS TAKEN. Place order sends the order with a token if one is already there, and
// without one otherwise (the server records it, internally unconfirmed). The page then keeps the check going and completes
// the SAME order (same idempotency key) when the token arrives. See orchestrate.js.
//
// TOKENS. A token is valid for 5 minutes and works once. A token older than 4.5 minutes is dropped, and so is one the
// server saw (resetTurnstile()).
//
// NOTHING RUNS BY ITSELF (the low-RAM-phone rule). Cloudflare's own `refresh-expired: auto` and `retry: auto` loop for as
// long as the page is open, which on a weak phone is a challenge solving over and over for no reason. They are switched
// off and this module owns the policy:
//  - the widget (a whole cross-origin iframe) is REMOVED as soon as it has delivered a token: the token lives in the form,
//    the iframe's memory and CPU go back to the page, and it is drawn again only when a fresh token is needed;
//  - a fresh token is needed only when the customer interacts with the form (or taps Place order) and the one they have
//    is missing or expired: the interaction wakes the check, nothing else does (no timer, no online/visibility listener);
//  - automatic restarts after an error, a timeout or an expiry are limited to AUTO_RESTARTS (2) in a row; after that the
//    check goes quiet until the next real interaction, which gives it a fresh allowance of 2.
//  - on EVERY device (no special low-end mode) it waits for a pause in typing, and leaves a gap between loading
//    Cloudflare's script and drawing the widget, so the two heavy steps never land together or between keystrokes.
//
// No site key means the challenge is not configured for this build (local development, where the server skips
// verification too): nothing is requested and every helper resolves at once.
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
let lastActivity = 0; // last keystroke/field change, so heavy work waits for a pause in typing
let lastField = null; // the field the customer was last in, to give focus back to it
let urgent = false; // Place order was pressed: do not wait for a pause any more
let deferred = [];
let autoLeft = 2; // automatic restarts still allowed before the check goes quiet (see AUTO_RESTARTS)
let dormant = false; // quiet: out of automatic restarts, waiting for the next real interaction

const AUTO_RESTARTS = 2;
const QUIET_MS = 1200;
// Between evaluating Cloudflare's script and drawing the widget, so the two heavy steps never land together.
const DRAW_GAP_MS = 800;
// One schedule for every device (a desktop gets lighter too, and a weak phone needs it): wait for a real pause in typing.
const quietMs = () => QUIET_MS;

/** The customer is acting: refill the automatic-restart allowance. Returns true if the check had gone quiet. */
function refill() {
  const wasDormant = dormant;
  autoLeft = AUTO_RESTARTS;
  dormant = false;
  return wasDormant;
}

/** One automatic restart, if any are left; otherwise the check goes quiet until the customer interacts again. */
function spend() {
  if (autoLeft > 0) { autoLeft -= 1; return true; }
  dormant = true;
  return false;
}

function runDeferred() {
  const list = deferred;
  deferred = [];
  for (const fn of list) fn();
}

/** Runs `fn` once the customer has stopped typing and the browser is idle; at once if they pressed Place order. */
function defer(fn) {
  if (urgent) return void fn();
  deferred.push(fn);
  const check = () => {
    if (!deferred.length) return; // already run (urgent)
    const wait = quietMs() - (Date.now() - lastActivity);
    if (wait > 0) return void setTimeout(check, wait);
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => (Date.now() - lastActivity < quietMs() ? check() : runDeferred()), { timeout: 3000 });
    } else {
      setTimeout(runDeferred, 0);
    }
  };
  if (deferred.length === 1) check();
}

function goUrgent() {
  urgent = true;
  runDeferred();
}

/** Cloudflare's frame can take keyboard focus when it is drawn. Give it back to the field the customer was typing in,
 *  unless they deliberately tapped the box. Watches only for a few seconds after the widget is drawn. */
function guardFocus(prev) {
  const host = hostEl();
  if (!host || !prev || prev === document.body) return;
  const until = Date.now() + 6000;
  let tapped = 0;
  const onTap = () => { tapped = Date.now(); };
  host.addEventListener("pointerdown", onTap, true);
  host.addEventListener("touchstart", onTap, true);
  const onFocus = () => {
    if (Date.now() > until) return void stop();
    if (Date.now() - tapped < 4000) return; // a real tap on the box
    const a = document.activeElement;
    if (a && (a === host || host.contains(a))) { try { prev.focus({ preventScroll: true }); } catch { /* element gone */ } }
  };
  const stop = () => {
    document.removeEventListener("focusin", onFocus, true);
    host.removeEventListener("pointerdown", onTap, true);
    host.removeEventListener("touchstart", onTap, true);
  };
  document.addEventListener("focusin", onFocus, true);
  setTimeout(stop, 6500);
}

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
  if (widgetId === null) return void ensureWidget(); // the widget was removed after the last token: draw a new one
  if (!window.turnstile) return;
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

/** Draws the widget if the script is there and no widget exists (it is removed after every token to free its iframe). */
function ensureWidget() {
  if (state !== "ready" || widgetId !== null) return;
  defer(() => {
    try { renderWidget(); } catch { state = "failed"; settle(new Error("Challenge could not start")); }
  });
}

/** Frees the widget's iframe once its token is safely in the form. The token stays valid without it. */
function removeWidget() {
  if (widgetId === null || !window.turnstile || typeof window.turnstile.remove !== "function") return;
  try { window.turnstile.remove(widgetId); widgetId = null; } catch { /* keep it: a later reset still works */ }
}

function renderWidget() {
  const host = hostEl();
  if (!host || !window.turnstile || widgetId !== null) return;
  solveAt = Date.now();
  const prevFocus = lastField && document.activeElement === lastField ? lastField : null;
  widgetId = window.turnstile.render(host, {
    sitekey: host.dataset.sitekey,
    appearance: "interaction-only",
    retry: "never", // this module decides when to try again, and how many times (AUTO_RESTARTS)
    "refresh-expired": "manual", // an expired token is replaced when the customer next interacts, never on a timer
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
      setTimeout(() => { if (tokenIsFresh()) removeWidget(); }, 0); // out of Cloudflare's callback first, then free the iframe
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
      if (spend()) scheduleRestart();
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
    "timeout-callback"() { if (spend()) restartSolve(false); },
    // An expired token is dropped; it is replaced (at most AUTO_RESTARTS times in a row) or left until the customer interacts.
    "expired-callback"() { clearToken(); if (spend()) restartSolve(false); },
    // The challenge needs a tap: show the box, and if someone is already waiting, bring it into view.
    "before-interactive-callback"() {
      interacted = true;
      showBox(true);
      // Someone is waiting on the check: make sure the box (right under the button) is on screen. Instant and minimal
      // ("nearest"), never a smooth scroll that makes the page appear to jump.
      if (waiters.length) hostEl()?.scrollIntoView?.({ block: "nearest" });
    },
    "after-interactive-callback"() { showBox(false); },
  });
  guardFocus(prevFocus);
  // The frame may take focus a moment after render() returns; the guard above is still listening then.
  if (prevFocus && host.contains(document.activeElement)) {
    try { prevFocus.focus({ preventScroll: true }); } catch { /* element gone */ }
  }
}

function loadScript() {
  loadAttempts += 1;
  state = "loading";
  // `onload` fires once api.js has defined window.turnstile, so render straight away. turnstile.ready() must NOT be used
  // here: it never calls back for a script that was added with async/defer, so the widget was never created and the
  // customer waited the full timeout at "Place order" with nothing ever loading.
  window.__turnstileLoaded = () => {
    state = "ready";
    // Drawing the widget is the heavy part: do it in a pause in typing, not between two keystrokes, and not in the same
    // stretch as evaluating Cloudflare's script.
    const draw = () => defer(() => {
      try { renderWidget(); } catch (e) { state = "failed"; settle(new Error("Challenge could not start")); }
    });
    if (urgent) draw(); else setTimeout(draw, DRAW_GAP_MS);
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
  defer(() => document.head.appendChild(script)); // after a pause in typing; at once if Place order was pressed
}

let wakeListening = false;
function arm() {
  if (!turnstileConfigured()) return;
  if (state === "failed") { state = "idle"; loadAttempts = 0; } // a later interaction gets a fresh try
  if (state !== "idle") return;
  loadScript();
}

/**
 * A real interaction with the form wakes a check that went quiet or whose token has expired. Cheap on every keystroke: it
 * returns at once unless a new token is actually needed and nothing is already working on one.
 */
function wakeOnInteraction() {
  if (!turnstileConfigured() || state === "idle" || state === "loading" || tokenIsFresh()) return;
  if (state === "failed") { refill(); return void arm(); }
  const working = widgetId !== null && !dormant && errors === 0 && Date.now() - solveAt <= STALL_MS;
  if (working) return;
  refill();
  errors = 0;
  restartSolve(false);
}

export function armTurnstile(formEl) {
  if (armed) return;
  if (!turnstileConfigured()) return; // no challenge in this build, nothing to arm
  armed = true;
  if (!formEl?.addEventListener) return;
  // The ONLY triggers: the customer focuses, types in, or changes a field of the order form. One tiny passive listener
  // per event, removed on the first hit. No IntersectionObserver, no scroll/pointer/anchor listener, no timer.
  const events = ["focusin", "input", "change"];
  const go = (e) => {
    lastActivity = Date.now();
    const t = e && e.target;
    if (t && t.matches && t.matches("input,textarea,select")) lastField = t;
    arm();
    wakeOnInteraction();
  };
  // These stay for the page's life: each call only records "the customer is typing" (one timestamp, one reference), which
  // is what lets the check wait for a pause. arm() does nothing after the first call.
  for (const ev of events) formEl.addEventListener(ev, go, { passive: true });
}

/** True when this build has a bot check at all (a site key is configured). */
export const checkConfigured = () => turnstileConfigured();

/** The token if one is ready, else "". Starts the check if it has not started, but NEVER waits for a script that has not
 *  loaded: Place order must not hang on it. With the check already running, waits at most `ms` for it. */
export function tokenForSubmit(ms) {
  if (!turnstileConfigured()) return Promise.resolve("");
  if (tokenIsFresh()) return Promise.resolve(inputEl()?.value || "");
  if (state === "idle" || state === "failed") { refill(); arm(); goUrgent(); return Promise.resolve(""); }
  goUrgent();
  return ensureToken(ms).then(() => inputEl()?.value || "", () => "");
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
  refill(); // the customer tapped: this is an interaction, so the check may try again
  arm();
  goUrgent(); // the customer is waiting on this: no more waiting for a pause in typing
  if (state === "failed") return Promise.reject(new Error("Challenge could not load"));
  if (widgetId === null) ensureWidget(); // the widget was removed after the last token (state is loading: onload draws it)
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
  // A spent token is replaced when the customer next interacts or taps Place order, not by solving in the background for
  // a customer who may already be gone. (A widget still on screen is reset so it is ready to be used.)
  if (widgetId !== null && window.turnstile) {
    try { window.turnstile.reset(widgetId); } catch { /* the widget is still loading: nothing to reset */ }
  }
  // Anyone parked on the old token can never be satisfied by it.
  settle(new Error("Challenge was reset"));
}
