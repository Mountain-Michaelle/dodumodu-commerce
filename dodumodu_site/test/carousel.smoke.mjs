import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

/* Slow Android phones showed a blank hero (and sections that blanked a moment after being scrolled past). Two causes, both
   checked here so they cannot come back:
   1. the script deleted the painted hero and built a new carousel -> now the printed slides are KEPT and only wired up;
   2. .lazy-section used content-visibility:auto -> no stylesheet may use it any more. */

const DIST = new URL("../dist/", import.meta.url);
const html = readFileSync(new URL("products/glow-serum/index.html", DIST), "utf8");
const bundle = readFileSync(new URL(html.match(/site\.[a-f0-9]+\.min\.js/)[0], DIST), "utf8");

// 1. No shipped CSS may skip rendering of off-screen content.
const css = readdirSync(DIST).filter((f) => f.endsWith(".css")).map((f) => readFileSync(new URL(f, DIST), "utf8")).join("\n") + html;
assert.ok(!/content-visibility/.test(css), "content-visibility makes low-memory Android blank sections while scrolling");

// 2. Three printed slides (the page prints one photo per gallery image).
const slide = html.match(/<div class="carousel-slide">[\s\S]*?<\/div>/)[0];
const three = html.replace(slide, slide + slide.replace(/ fetchpriority="high"/, ' loading="lazy"') + slide.replace(/ fetchpriority="high"/, ' loading="lazy"'));
assert.equal((three.match(/class="carousel-slide"/g) || []).length, 3);

const vc = new VirtualConsole(); vc.on("jsdomError", (e) => { throw e; });
const dom = new JSDOM(three, { url: "https://yoursite.com/products/glow-serum/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom; const doc = window.document;
window.fetch = async () => { throw new Error("no network"); };
window.requestIdleCallback = (fn) => fn();
window.Element.prototype.scrollTo = function () {};
window.IntersectionObserver = class { observe() {} disconnect() {} };

const track = doc.querySelector("#carousel .carousel");
const before = [...track.querySelectorAll("img")];
assert.equal(before.length, 3);
window.eval(bundle);
await new Promise((r) => setTimeout(r, 80));

const after = [...doc.querySelectorAll("#carousel .carousel img")];
assert.equal(after.length, 3, "still three slides");
assert.ok(after.every((img, i) => img === before[i] && doc.contains(img)), "the painted slide elements are the SAME nodes: nothing was rebuilt");
assert.equal(doc.querySelectorAll("#carousel .carousel").length, 1);
assert.equal(doc.querySelectorAll(".carousel-dot").length, 3, "dots are added for the printed slides");
assert.equal(doc.querySelectorAll(".carousel-arrow").length, 2);
assert.equal(doc.querySelector(".carousel-arrow--prev").disabled, true);
assert.equal(doc.querySelector(".carousel-dot[data-active='true']")?.getAttribute("aria-label"), "Go to photo 1");
doc.querySelector(".carousel-arrow--next").click();
assert.equal(doc.querySelector(".carousel-dot[data-active='true']")?.getAttribute("aria-label"), "Go to photo 2", "next works on printed slides");
assert.equal(doc.querySelector(".carousel-arrow--prev").disabled, false);
assert.equal(track.getAttribute("tabindex"), "0");

// 3. A page with a single photo gets no arrows or dots.
const one = new JSDOM(html, { url: "https://yoursite.com/products/glow-serum/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc });
one.window.fetch = async () => { throw new Error("no network"); };
one.window.requestIdleCallback = (fn) => fn();
const heroBefore = one.window.document.querySelector("#carousel img");
one.window.eval(bundle);
await new Promise((r) => setTimeout(r, 60));
assert.equal(one.window.document.querySelector("#carousel img"), heroBefore, "the single hero is the same node");
assert.equal(one.window.document.querySelectorAll(".carousel-dot, .carousel-arrow").length, 0);

console.log("PASS carousel: printed slides are kept and wired (3 and 1 photo), no content-visibility anywhere");
