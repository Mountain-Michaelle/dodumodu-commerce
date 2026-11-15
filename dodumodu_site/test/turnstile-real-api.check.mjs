// The widget must be created from api.js's `onload` callback. Cloudflare's turnstile.ready() never calls back for a
// script added with async/defer, so an implementation that waited for it never rendered the widget at all and every
// customer sat at "Place order" until the timeout. This fake behaves like that: ready() is a no-op.
import assert from "node:assert/strict";

const input = { value: "" };
const host = { dataset: { sitekey: "0x4AAAAAAAtestkey" }, scrollIntoView() {} };
const scripts = [];
let rendered = null;
globalThis.window = {
  turnstile: {
    ready() { /* real api.js: never calls back for async/defer scripts */ },
    render(_el, opts) { rendered = opts; return "w1"; },
    reset() { input.value = ""; },
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

const { armTurnstile, ensureToken } = await import("../shared/scripts/turnstile.js");
armTurnstile({ addEventListener() {} });
assert.equal(scripts.length, 1, "the challenge script is requested once the page has loaded");
assert.ok(/onload=__turnstileLoaded/.test(scripts[0].src), "api.js is told to call us when it is ready");

window.__turnstileLoaded(); // what api.js does when it has loaded
assert.ok(rendered, "the widget is rendered from the onload callback, not from turnstile.ready()");
assert.equal(rendered.appearance, "interaction-only");

const pending = ensureToken();
rendered.callback("tok-123"); // Cloudflare solved the challenge
await pending;
assert.equal(input.value, "tok-123", "the token is in the form");

// A configuration error (bad key, hostname not allowed) fails at once with a distinct code, not after the timeout.
input.value = "";
const second = ensureToken();
assert.equal(rendered["error-callback"]("110200"), true);
await assert.rejects(second, (e) => e.code === "turnstile_config");

console.log("PASS  turnstile renders from onload and reports configuration errors immediately");
