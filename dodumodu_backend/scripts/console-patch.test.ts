import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PATCHES, PATCH_MARK, NEW_ORDER_SOURCE, patchConsoleJs, gateNav } from "./console-patch.mjs";
import { ADMIN_CONSOLE_ASSETS, ADMIN_CONSOLE_HTML } from "../src/generated/adminPages";

const js = Object.entries(ADMIN_CONSOLE_ASSETS).find(([n]) => n.endsWith(".min.js"))!;
test("shipped console bundle carries every fix and is referenced by its hashed name", () => {
  assert.ok(js[1].startsWith(PATCH_MARK));
  assert.ok(ADMIN_CONSOLE_HTML.includes(js[0]));
  for (const p of PATCHES) { assert.ok(js[1].includes(p.to), p.id); if (!p.to.includes(p.from)) assert.ok(!js[1].includes(p.from), `${p.id}: unpatched text still present`); }
});
test("the shipped bundle carries the CURRENT new-order script (regenerate adminPages.ts after editing it)", () => {
  assert.ok(js[1].includes(NEW_ORDER_SOURCE));
});
test("patching is idempotent, skips fixes a bundle already has, and refuses an ambiguous anchor", () => {
  assert.equal(patchConsoleJs(js[1]), js[1]);
  assert.ok(patchConsoleJs("function other(){}").includes("function other(){}"), "an unrelated bundle is not rejected");
  assert.throws(() => patchConsoleJs(`${PATCHES[0].from};${PATCHES[0].from}`), /expected at most 1 match, found 2/);
});
test("generator writes the same bundle that is shipped", () => {
  assert.match(readFileSync(new URL("./build-admin-pages.mjs", import.meta.url), "utf8"), /patchConsoleJs/);
});

// A miniature console with just the places the sidebar gating touches, under caller-chosen minified names.
const mini = (list: string, ident: string, opts: { sidebar?: boolean } = {}) =>
  `function ut({root:a,onNavigate:s,identity:${ident}}){let n=${opts.sidebar === false ? 'e("nav",{class:"other"},X.map(h=>1))' :
    `e("nav",{class:"sidebar-nav","aria-label":"Sections"},${list}.map(h=>e("div",{class:"nav-group"},e("h2",{class:"nav-group-title",text:h.group}),e("ul",{class:"nav-list"},h.items.map(f=>{`}return{content:r,toolbar:u,titleFor(h){}}}` +
  `var ${list}=[{group:"Catalogue",items:[{id:"orders",label:"Orders",perm:"orders.view"},{id:"media",label:"Media"}]},{group:"System",items:[{id:"blocks",label:"Blocked"},{id:"discounts",label:"Discount tiers"},{id:"payment",label:"Payment rules"}]}];`;

test("sidebar gating reads the console's own minified names (a rebuilt console renames them)", () => {
  for (const [list, ident] of [["Zt", "t"], ["Qz", "me"]]) {
    const out = gateNav(mini(list, ident))!;
    assert.ok(out, `${list}/${ident}: applied`);
    assert.ok(out.includes(`${list}.flatMap(`) && out.includes(`__aaAllowed(${ident},f)`));
    if (list !== "Zt") assert.ok(!/\bZt\b/.test(out), "no stale name from another build is left behind");
    assert.ok(out.includes('{id:"media",label:"Media",perm:"media.view"}') && out.includes('perm:"settings.manage"') && out.includes('perm:"blocks.manage"'));
    assert.equal(gateNav(out), out, "idempotent");
  }
});

test("sidebar gating is all-or-nothing: if any anchor is missing NOTHING is injected (never a half-applied shell)", () => {
  const out = gateNav(mini("Qz", "t", { sidebar: false }));
  assert.equal(out, null);
  const patched = patchConsoleJs(mini("Qz", "t", { sidebar: false }));
  for (const frag of ["isHidden", "firstVisible", "__aaAllowed", 'perm:"media.view"']) assert.ok(!patched.includes(frag), `${frag} must not be injected`);
  assert.equal(gateNav("function nothing(){}"), null);
});

test("the injected gating can never block a screen: a lookup failure means 'show it'", () => {
  const out = gateNav(mini("Qz", "t"))!;
  assert.match(out, /isHidden:h=>\{try\{/);
  assert.match(out, /catch\{return!1\}/);
  assert.match(out, /function __aaAllowed\(i,f\)\{try\{/);
});
