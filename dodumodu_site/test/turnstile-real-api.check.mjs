// The widget must be created from api.js's `onload` callback. Cloudflare's turnstile.ready() never calls back for a
// script added with async/defer, so an implementation that waited for it never rendered the widget at all and every
// customer sat at "Place order" until the timeout. This fake behaves like that: ready() is a no-op.
import assert from "node:assert/strict";

const input = { value: "" };
const host = { dataset: { sitekey: "0x4AAAAAAAtestkey" }, scrollIntoView() {} };
const scripts = [];
let rendered = null;
let resets = 0;
globalThis.window = {
  turnstile: {
    ready() { /* real api.js: never calls back for async/defer scripts */ },
    render(_el, opts) { rendered = opts; return "w1"; },
    reset() { resets += 1; input.value = ""; },
  },
  addEventListener() {},
};
globalThis.document = {
  readyState: "complete",
  getElementById: (id) => (id === "cf-turnstile" ? host : null),
  querySelector: () => input,
  createElement: () => ({ remove() {} }),
  head: { appendChild: (el) => scripts.push(el) },
};
globalThis.requestIdleCallback = (fn) => fn();

// The challenge starts on INTENT, not at page load: nothing is requested until the form is near the screen or touched.
let observe = null;
globalThis.IntersectionObserver = class { constructor(cb) { observe = cb; } observe() {} disconnect() {} };
const formListeners = {};
const formEl = { addEventListener(ev, fn) { formListeners[ev] = fn; }, removeEventListener() {} };
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};

const { armTurnstile, ensureToken, checkFailed, onNextToken } = await import("../shared/scripts/turnstile.js");
armTurnstile(formEl);
assert.equal(scripts.length, 0, "nothing is requested while the customer is still at the top of the page");
observe([{ isIntersecting: false }]);
assert.equal(scripts.length, 0, "and not while the form is far away");
observe([{ isIntersecting: true }]); // the form is about two screens away
assert.equal(scripts.length, 1, "the challenge script is requested when the form is approaching");
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
process.exit(0); // the 8-second safety-net timer is not waited for
