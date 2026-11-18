// The widget must be created from api.js's `onload` callback. Cloudflare's turnstile.ready() never calls back for a
// script added with async/defer, so an implementation that waited for it never rendered the widget at all and every
// customer sat at "Place order" until the timeout. This fake behaves like that: ready() is a no-op.
import assert from "node:assert/strict";

const input = { value: "" };
const host = { dataset: { sitekey: "0x4AAAAAAAtestkey" }, scrollIntoView() {} };
const scripts = [];
const globalListeners = [];
let rendered = null;
let resets = 0;
globalThis.window = {
  turnstile: {
    ready() { /* real api.js: never calls back for async/defer scripts */ },
    render(_el, opts) { rendered = opts; return "w1"; },
    reset() { resets += 1; input.value = ""; },
  },
  addEventListener(ev) { globalListeners.push(`window:${ev}`); },
};
globalThis.document = {
  readyState: "complete",
  getElementById: (id) => (id === "cf-turnstile" ? host : null),
  querySelector: () => input,
  createElement: () => ({ remove() {} }),
  head: { appendChild: (el) => scripts.push(el) },
};
globalThis.requestIdleCallback = (fn) => fn();

// The challenge starts ONLY on genuine form interaction (focus, typing, changing a field): never on load, scroll, idle,
// a timer, or the form coming into view. Observers and timers are forbidden outright.
globalThis.IntersectionObserver = class { constructor() { throw new Error("IntersectionObserver must not be used"); } };
const timersBefore = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => { timersBefore.push(ms); return realSetTimeout(fn, ms, ...a); };
const formListeners = {};
const formEl = {
  addEventListener(ev, fn) { (formListeners[ev] ||= []).push(fn); },
  removeEventListener(ev, fn) { formListeners[ev] = (formListeners[ev] || []).filter((f) => f !== fn); },
};
globalThis.document.addEventListener = (ev) => { globalListeners.push(`document:${ev}`); };
globalThis.document.removeEventListener = () => {};

const { armTurnstile, ensureToken, checkFailed, onNextToken, tokenForSubmit, checkConfigured } = await import("../shared/scripts/turnstile.js");
armTurnstile(formEl);
assert.deepEqual(Object.keys(formListeners).sort(), ["change", "focusin", "input"], "the ONLY triggers are focusin, input and change");
assert.equal(scripts.length, 0, "nothing is requested at page load");
assert.deepEqual(globalListeners, [], "no window/document listener (scroll, visibility, online, load) exists before the first interaction");
assert.equal(timersBefore.length, 0, "no timer is scheduled by arming");
await new Promise((r) => realSetTimeout(r, 400));
assert.equal(scripts.length, 0, "and nothing starts on its own after load, idle or time passing");
assert.equal(checkConfigured(), true);
// Place order tapped before the check ever started: the order must not wait for a script that has not loaded.
const quick = await Promise.race([tokenForSubmit(1500), new Promise((r) => realSetTimeout(() => r("TIMED-OUT"), 200))]);
assert.equal(quick, "", "submitting before the check loaded returns at once with no token (the order is sent unconfirmed)");
assert.equal(scripts.length, 1, "...and that submit starts the check, once, for the page to prompt");
// (the first interaction listeners fire later in the real page; arming again must not add a second script)
for (const fn of [...(formListeners.focusin || [])]) fn();
assert.equal(scripts.length, 1, "interaction after the check started does not load it a second time");
assert.ok(/onload=__turnstileLoaded/.test(scripts[0].src), "api.js is told to call us when it is ready");

window.__turnstileLoaded(); // what api.js does when it has loaded
assert.ok(rendered, "the widget is rendered from the onload callback, not from turnstile.ready()");
assert.equal(rendered.appearance, "interaction-only");

const pending = ensureToken();
rendered.callback("tok-123"); // Cloudflare solved the challenge
await pending;
assert.equal(input.value, "tok-123", "the token is in the form");

// A transient widget error while a customer waits: the box is shown (so Cloudflare's own message and Retry are reachable)
// and the solve is restarted by the page within about a second, not left dead behind an invisible widget.
input.value = "";
host.dataset.ready = "false";
const waiting = ensureToken(5000);
const resetsBefore = resets;
assert.equal(rendered["error-callback"]("300030"), false, "transient errors are left to Cloudflare as well");
assert.equal(host.dataset.ready, "true", "a customer who is waiting can see the box after an error");
await new Promise((r) => setTimeout(r, 1500));
assert.ok(resets > resetsBefore, "the page restarted the solve by itself after the error");
rendered.callback("tok-after-error");
await waiting;
assert.equal(input.value, "tok-after-error");
assert.equal(host.dataset.ready, "false", "the box is hidden again once a token arrives");

// A round of waiting that failed starts the check over at once, and again at the customer's next tap.
input.value = "";
const beforeFail = resets;
checkFailed();
assert.ok(resets > beforeFail, "a failed round restarts the check immediately");
const beforeTap = resets;
const tap = ensureToken(300);
assert.ok(resets > beforeTap, "the next tap restarts it again when there is still no token");
await assert.rejects(tap);

// A token that arrives with nobody waiting still reaches whoever asked to be told (finishing a recorded order).
let heard = "";
onNextToken((t) => { heard = t; });
rendered.callback("tok-late");
assert.equal(heard, "tok-late");
rendered.callback("tok-later");
assert.equal(heard, "tok-late", "a listener is called once");

// A configuration error (bad key, hostname not allowed) fails at once with a distinct code, not after the timeout.
input.value = "";
const second = ensureToken();
assert.equal(rendered["error-callback"]("110200"), true);
await assert.rejects(second, (e) => e.code === "turnstile_config");

process.on("exit", () => {});
console.log("PASS  turnstile renders from onload, restarts after errors, and reports configuration errors immediately");

// A fresh page: the first genuine interaction (typing) starts the check exactly once, whichever event it is.
{
  const fresh = await import("../shared/scripts/turnstile.js?fresh-page");
  const listeners = {};
  const form = {
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
  };
  const before = scripts.length;
  const globalBefore = globalListeners.length;
  fresh.armTurnstile(form);
  assert.equal(scripts.length, before, "arming alone requests nothing");
  assert.equal(globalListeners.length, globalBefore, "arming alone registers no global listener");
  for (const fn of [...listeners.input]) fn({ type: "input" }); // the customer types one character
  assert.equal(scripts.length, before, "typing starts the check, but the script is NOT injected between keystrokes");
  await new Promise((r) => realSetTimeout(r, 300));
  for (const fn of [...listeners.input]) fn({ type: "input" }); // still typing: the pause timer restarts
  await new Promise((r) => realSetTimeout(r, 500));
  assert.equal(scripts.length, before, "still typing 800ms after the first key: nothing injected yet");
  await new Promise((r) => realSetTimeout(r, 600));
  assert.equal(scripts.length, before + 1, "after a pause in typing the script is injected, once");
  for (const ev of ["input", "change", "focusin"]) for (const fn of listeners[ev] || []) fn();
  assert.equal(scripts.length, before + 1, "more typing, selecting or focusing never starts it again (once per lifecycle)");
  assert.ok(globalListeners.length > globalBefore, "online/visibility recovery listeners exist only after the check started");
}
console.log("PASS  turnstile starts only on first form interaction, once, with no observer, timer or scroll trigger");
process.exit(0); // pending Cloudflare-restart timers are not waited for
