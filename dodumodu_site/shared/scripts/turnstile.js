// Loads Cloudflare Turnstile only when it can matter.
//
// Turnstile is 100-200 KB of third-party JavaScript plus a cross-origin TLS
// handshake, and it is only needed once a human is about to submit. Loading it
// on first paint put it in the critical path on exactly the poor connections
// where losing a customer hurts most, so it is armed instead when the form is
// about to be on screen (IntersectionObserver) or the moment any field takes
// focus — and, at worst, on submit, where we wait for it rather than fail.
//
// The widget container is `display:none` until the script is in, so no layout
// shift is possible: the box only ever appears below the fold of the form.
//
// The page's own `onTurnstileToken` global calls window.__turnstileTokenReceived,
// which is how ensureToken() knows the customer solved the challenge rather than
// merely downloaded the script.
//
// No site key means the challenge is not configured for this build — local
// development, where the widget cannot be solved and the server skips
// verification too. In that case nothing is requested at all and ensureToken()
// resolves immediately, instead of loading a third-party script that can never
// hand back a usable token.
const API_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const TOKEN_TIMEOUT_MS = 10_000;

let state = "idle"; // idle -> loading -> ready | failed
let pending = null; // { resolve, reject, timer }

function turnstileConfigured() {
  const host = document.getElementById("cf-turnstile");
  return Boolean(host?.dataset.sitekey);
}

function settle(error) {
  const waiter = pending;
  pending = null;
  if (!waiter) return;
  clearTimeout(waiter.timer);
  if (error) waiter.reject(error);
  else waiter.resolve();
}

function arm() {
  if (state !== "idle") return;
  const host = document.getElementById("cf-turnstile");
  if (!host) return;
  if (!turnstileConfigured()) return; // nothing to load; the widget stays hidden
  state = "loading";

  const script = document.createElement("script");
  script.src = API_SRC;
  script.async = true;
  script.defer = true;
  script.onload = () => {
    state = "ready";
    host.dataset.ready = "true"; // reveals the widget; no CLS, it sits below the fold
  };
  script.onerror = () => {
    state = "failed";
    // Fail open in the browser: the server still verifies whatever token
    // arrived (possibly none) and is the only real gate. Blocking checkout
    // because a third-party CDN is down would cost more than it protects.
    settle(new Error("Challenge could not load"));
  };
  document.head.appendChild(script);
}

export function armTurnstile(formEl) {
  if (state !== "idle") return;
  window.__turnstileTokenReceived = () => settle(null);
  if (!turnstileConfigured()) return; // no challenge in this build — nothing to arm

  const trigger = () => arm();
  if ("IntersectionObserver" in window && formEl) {
    // Start downloading just before the form scrolls into view, so by the time
    // the customer reaches the submit button the widget is usually there.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        trigger();
        observer.disconnect();
      }
    }, { rootMargin: "600px" });
    observer.observe(formEl);
  }

  // Older WebViews with no IntersectionObserver still get it on first touch.
  formEl?.addEventListener("focusin", trigger, { once: true, passive: true });
}

/**
 * Load the challenge (if it is not already up) and wait for the customer's
 * token. Resolves on success; rejects on failure or timeout so the caller can
 * explain itself rather than posting an order the API will refuse.
 */
export function ensureToken() {
  if (document.querySelector('input[name="turnstileToken"]')?.value) return Promise.resolve();
  if (!turnstileConfigured()) return Promise.resolve(); // no challenge configured
  arm();
  if (state === "failed") return Promise.reject(new Error("Challenge could not load"));
  if (pending) return new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });

  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    pending.timer = setTimeout(() => {
      pending = null;
      reject(new Error("Challenge timed out"));
    }, TOKEN_TIMEOUT_MS);
  });
}

/**
 * Drops a spent token so the next submit asks Cloudflare for a fresh one.
 *
 * Turnstile tokens are single-use, and arm() deliberately refuses to run again
 * once the script has loaded (state !== "idle"). A page restored from the
 * back/forward cache after placing an order therefore still holds the token it
 * just redeemed: ensureToken() would short-circuit on it and hand the API
 * something that can never verify, so instead of an honest 400 the customer
 * would sit through TOKEN_TIMEOUT_MS and be told the check failed.
 */
export function resetTurnstile() {
  const input = document.querySelector('input[name="turnstileToken"]');
  if (input) input.value = "";
  const host = document.getElementById("cf-turnstile");
  if (host && window.turnstile) {
    try {
      window.turnstile.reset(host);
    } catch {
      /* the widget is still loading — there is nothing to reset */
    }
  }
  // A waiter parked on the old token can never settle now, so fail it rather
  // than leaving that promise hanging.
  settle(new Error("Challenge was reset"));
}
