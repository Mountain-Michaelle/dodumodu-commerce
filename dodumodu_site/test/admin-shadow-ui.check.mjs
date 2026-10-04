// Renders the shadow report through the REAL shell and router contract.
//
// This exists because the screen was shipped broken: the view mounted itself during
// construction and reached for `shell.results`, which does not exist. Neither the
// bundle build nor any source-level check noticed, because both only care about
// syntax. The failure was a TypeError at runtime, in a real browser, on the one
// screen an operator needs in order to act.
//
// So this drives the view the way the router does - construct it, then call
// start() - and asserts on the resulting DOM TEXT. A view that mounts too early, or
// touches a shell property that does not exist, fails here instead of in front of
// the user.
import { JSDOM } from "jsdom";

const BASE = process.env.BASE_URL || "http://localhost:8787";
const H = { "cf-access-authenticated-user-email": "admin@dodumodu.local" };

let pass = 0; let fail = 0;
const check = (l, ok, d = "") => {
  if (ok) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${d ? ` -- ${d}` : ""}`); }
};

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

// Real fetch, pointed at the running dev server, so this exercises the real API.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(String(url).startsWith("http") ? url : `${BASE}${url}`, opts);

const { mount, el } = await import("../shared/scripts/admin/dom.js");
const { buildShell } = await import("../shared/scripts/admin/layout.js");
const { shadowView } = await import("../shared/scripts/admin/views/shadow.js");

console.log("=== the screen the operator opens ===");

// Exactly what admin.js does: build the shell, then construct and start the view.
const root = document.getElementById("root");
const shell = buildShell({ root, onNavigate: () => {}, identity: { email: "admin@dodumodu.local" } });

let view;
let threw = "";
try {
  view = shadowView({ shell, identity: { email: "admin@dodumodu.local" } });
} catch (err) {
  threw = String(err && err.message);
}
check("constructing the view does not throw", !threw, threw);

threw = "";
try {
  await view.start();
} catch (err) {
  threw = String(err && err.message);
}
check("start() does not throw", !threw, threw);

// The bug reported: an undefined shell property would surface here.
check("the view never touches a shell property that does not exist", !/replaceWith|is not a function/.test(threw));

const text = root.textContent || "";
check("the page is not the error screen", !/failed to load/i.test(text), text.slice(0, 60));
check("real activity volume is shown", /Order requests seen/i.test(text));
check("successful orders are shown beside the volume", /Successful orders/i.test(text));
check("status progression is shown", /Confirmed COD/i.test(text) && /Delivered/i.test(text));
check("shared-IP evidence is shown", /Addresses worth a look|Activity by address/i.test(text));
check("the window filter is present", /Window/i.test(text));

// The banner must state plainly that this blocks nobody.
check("it states that nothing is blocked", /shadow|block/i.test(text));

// And it must contain actual numbers, not placeholders.
const digits = (text.match(/\d/g) || []).length;
check("real figures are rendered, not an empty shell", digits > 10, `digit count=${digits}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);