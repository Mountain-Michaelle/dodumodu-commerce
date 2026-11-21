// The WhatsApp screenshot form: how many images it may hold depends on how many the PRODUCT already shows (max 5).
// One saved -> you can upload more (up to 4 more); five saved -> only Change. Drives the real view in a DOM.
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

const dom = new JSDOM("<!doctype html><html><body><main id=content></main></body></html>", { url: "http://localhost/admin/", pretendToBeVisual: true });
for (const k of ["window", "document"]) globalThis[k] = dom.window[k === "window" ? "window" : "document"];
for (const k of ["HTMLElement", "Node", "Event", "CustomEvent", "FormData", "File", "URLSearchParams"]) globalThis[k] = dom.window[k] || globalThis[k];
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

let counts = { 3: 1 };
const rows = [{ id: 11, title: "Chat", kind: "whatsapp", r2Key: "uploads/a.png", productId: 3, active: true, displayOrder: 0 }];
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^.*\/admin/, "");
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  if (init.method === "POST" || init.method === "PUT") { sent.push([init.method, path, JSON.parse(init.body)]); return json({ testimonial: { id: 99 } }); }
  if (path.startsWith("/testimonials")) return json({ testimonials: rows, page: { page: 1, pageSize: 20, total: 1, totalPages: 1 }, screenshotCounts: counts, maxScreenshots: 5 });
  if (path.startsWith("/products")) return json({ products: [{ id: 3, name: "Glow Serum" }] });
  return json({});
};

const { testimonialsView } = await import("../shared/scripts/admin/views/testimonials.js");
const shell = { content: document.getElementById("content") };
testimonialsView({ shell, identity: { permissions: ["products:write"] } }).start();
const settle = () => new Promise((r) => setTimeout(r, 60));
await settle();

const open = async () => {
  document.querySelector("tbody tr, [role=row]:not(:first-child)")?.click?.();
  (document.querySelector("tbody tr") || document.querySelector("[data-row-key]"))?.click();
  await settle();
};
const text = () => document.body.textContent;
const buttons = () => [...document.querySelectorAll("dialog button, [role=dialog] button, .modal button")].map((b) => b.textContent.trim());

await open();
assert.ok(/Chat/.test(text()), "list shows the screenshot");
let b = buttons();
assert.ok(b.includes("Change image"), `a saved screenshot can be changed (${b.join("|")})`);
assert.ok(b.includes("Upload more images…"), "with one of five used, more can be uploaded");
assert.ok(/1 of up to 5/.test(text()), "says how many fit");
assert.ok(!b.includes("Remove"), "the row's own screenshot cannot be removed here (hide it with Visible)");

// Five visible already (this row + four others): only Change.
document.querySelector(".modal-close, [aria-label=Close]")?.click();
document.body.querySelectorAll("dialog, [role=dialog]").forEach((d) => d.remove());
counts = { 3: 5 };
shell.content.innerHTML = "";
testimonialsView({ shell, identity: { permissions: ["products:write"] } }).start();
await settle(); await open();
b = buttons();
assert.ok(b.includes("Change image") && !b.includes("Upload more images…"), `at five, only Change is offered (${b.join("|")})`);
console.log("PASS  screenshot form: upload more while the product has fewer than 5, only change at 5");
process.exit(0);
