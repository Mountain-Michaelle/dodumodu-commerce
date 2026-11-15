// The bot check (Cloudflare Turnstile), built so a customer never waits for it and never sees it unless Cloudflare
// itself needs a tap.
//
// WHEN IT LOADS. It is requested at the earlier of: the page's `load` event plus an idle moment (so the first paint and
// the hero image are never competing with it, but it is already solving long before anyone reaches the button), or the
// first touch of a field. Before, it waited for the form to be near the screen, which on a slow phone meant the whole
// download-and-solve happened while the customer was filling the form and was often still running at "Place order".
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

let state = "idle"; // idle -> loading -> ready | failed
let widgetId = null;
let issuedAt = 0;
let loadAttempts = 0;
let armed = false;
let waiters = []; // [{ resolve, reject, timer }]

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

const showBox = (visible) => { hostEl().dataset.ready = String(visible); };

function renderWidget() {
  const host = hostEl();
  if (!host || !window.turnstile || widgetId !== null) return;
  widgetId = window.turnstile.render(host, {
    sitekey: host.dataset.sitekey,
    appearance: "interaction-only",
    retry: "auto",
    "refresh-expired": "auto",
    callback(token) {
      const input = inputEl();
      if (input) input.value = token;
      issuedAt = Date.now();
      showBox(false);
      settle(null);
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
      return false; // transient: Cloudflare retries (retry: "auto")
    },
    "expired-callback": clearToken, // Cloudflare retries errors itself (retry: auto); WAIT_MS is the only give-up
    // The challenge needs a tap: show the box, and if someone is already waiting, bring it into view.
    "before-interactive-callback"() {
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

export function armTurnstile(formEl) {
  if (armed) return;
  if (!turnstileConfigured()) return; // no challenge in this build, nothing to arm
  armed = true;

  // 1. After the page itself has finished, in an idle moment: the normal path, early and invisible.
  const afterLoad = () => whenIdle(arm);
  if (document.readyState === "complete") afterLoad();
  else window.addEventListener?.("load", afterLoad, { once: true });

  // 2. Sooner, on intent: the customer touches a field before the page has finished loading.
  formEl?.addEventListener("focusin", arm, { once: true, passive: true });
}

/**
 * Resolves when a fresh, unspent token is in the form; rejects if there is none after WAIT_MS or the challenge cannot
 * load. Normally the token has been there for a while and this returns at once.
 */
export function ensureToken() {
  if (!turnstileConfigured()) return Promise.resolve();
  if (tokenIsFresh()) return Promise.resolve();

  // A token that is present but old would be refused by the server: re-solve it instead of sending it.
  if (inputEl()?.value) {
    clearToken();
    if (widgetId !== null) try { window.turnstile.reset(widgetId); } catch { /* still loading */ }
  }
  arm();
  if (state === "failed") return Promise.reject(new Error("Challenge could not load"));

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    waiter.timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== waiter);
      reject(new Error("Challenge timed out"));
    }, WAIT_MS);
    waiters.push(waiter);
  });
}

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
