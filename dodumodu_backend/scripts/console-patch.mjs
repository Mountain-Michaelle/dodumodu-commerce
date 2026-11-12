// Fixes for the admin console bundle (built by dodumodu_site, not part of this repository).
// Each patch replaces one exact, unique piece of the minified bundle and fails loudly if the bundle contains it
// more than once; a fix the bundle already has natively is skipped. Applying is idempotent.
//
//  1. table-empty-state : the shared table helper (Y) returned the "empty" panel whenever an `empty` option was
//     passed, even when rows existed, so Users and Auth log never listed anything. The empty panel is now
//     shown only when there are no rows, and a plain string `empty` is accepted as the title.
//  2. identity-permissions : the console read its permission list from `perms` of /auth/me (the new-style keys,
//     empty for the legacy ones) so every "Add"/"Upload" control gated on products:write, categories:write,
//     media:write, testimonials... stayed hidden. It now prefers the `permissions` list /auth/me returns.
//  3. clear-toolbar : the page toolbar (where Users puts "+ Add user") was not cleared on navigation, so the
//     button leaked onto unrelated sections until a refresh.
//  5. nav-permissions / nav-gating : the sidebar listed every section for everybody and had no "hide what I may
//     not open". Each section now carries the registry key that gates it (media, blocked, settings included),
//     sections the signed-in user does not hold are not listed, and opening one by URL falls back to the first
//     section they may use. The server enforces the same keys on every request (src/auth/route-access.ts).
//  6. new-order : "+ New order" on Orders (src/auth-ui/console-new-order.js), appended as its own script.
//  4. route-scoped-shell : a view that finishes loading after the operator has moved on wrote its toolbar and
//     content into the NEW section. Each route now gets a shell whose targets are detached once it is stale.
import { readFileSync } from "node:fs";
export const PATCH_MARK = "/*console-fixes*/";
export const NEW_ORDER_SOURCE = readFileSync(new URL("../src/auth-ui/console-new-order.js", import.meta.url), "utf8");
export const NEW_ORDER_MARK = "/*console-new-order*/";

export const PATCHES = [
  {
    id: "table-empty-state",
    from: 'if(n)return e("div",{class:"table-state"},e("p",{class:"table-state-title",text:n.title||"Nothing here yet"})',
    to: 'if(n&&(!s||s.length===0))return n=typeof n=="string"?{title:n}:n,e("div",{class:"table-state"},e("p",{class:"table-state-title",text:n.title||"Nothing here yet"})',
  },
  {
    id: "identity-permissions",
    from: 'role:s.role,permissions:s.perms||[]}',
    to: 'role:s.role,permissions:Array.isArray(s.permissions)?s.permissions:s.perms||[]}',
  },
  {
    id: "clear-toolbar",
    from: 'N(!1),He(r)},closeNav:()=>N(!1)}',
    to: 'N(!1),He(r),He(u)},closeNav:()=>N(!1)}',
  },
  {
    id: "route-scoped-shell",
    from: 'let t=Yt[a]({shell:fe,identity:he,onNavigate:Gt})',
    to: 'let k=window.__aaRoute=(window.__aaRoute||0)+1,dc=document.createElement("div"),dt2=document.createElement("div"),sh=Object.create(fe,{toolbar:{get:()=>k===window.__aaRoute?fe.toolbar:dc},content:{get:()=>k===window.__aaRoute?fe.content:dt2}}),t=Yt[a]({shell:sh,identity:he,onNavigate:Gt})',
  },
];

const count = (s, needle) => s.split(needle).length - 1;


// Earlier builds of this script wrote the sidebar gating with fixed minified names. Undo exactly that text first
// so a bundle that already carries it is re-patched by gateNav() instead of keeping the fragile version.
const LEGACY_NAV = [
  ['{id:"media",label:"Media"}', '{id:"media",label:"Media",perm:"media.view"}'],
  ['{id:"blocks",label:"Blocked"}', '{id:"blocks",label:"Blocked",perm:"blocks.manage"}'],
  ['{id:"discounts",label:"Discount tiers"},{id:"payment",label:"Payment rules"}', '{id:"discounts",label:"Discount tiers",perm:"settings.manage"},{id:"payment",label:"Payment rules",perm:"settings.manage"}'],
  ['e("nav",{class:"sidebar-nav","aria-label":"Sections"},Zt.map(h=>e("div",{class:"nav-group"},e("h2",{class:"nav-group-title",text:h.group}),e("ul",{class:"nav-list"},h.items.map(f=>{',
   'e("nav",{class:"sidebar-nav","aria-label":"Sections"},Zt.map(h=>({...h,items:h.items.filter(f=>__aaAllowed(t,f))})).filter(h=>h.items.length).map(h=>e("div",{class:"nav-group"},e("h2",{class:"nav-group-title",text:h.group}),e("ul",{class:"nav-list"},h.items.map(f=>{'],
  ['{content:r,toolbar:u,titleFor(h){',
   '{isHidden:h=>{let f=Zt.flatMap(g=>g.items).find(g=>g.id===h);return!!f&&!__aaAllowed(t,f)},firstVisible:()=>{let f=Zt.flatMap(g=>g.items).find(g=>__aaAllowed(t,g));return f&&f.id},content:r,toolbar:u,titleFor(h){'],
  ['var Zt=[{group:"Catalogue"',
   'function __aaAllowed(i,f){return!f.perm||!i||i.role==="admin"||!Array.isArray(i.v2perms)||i.v2perms.includes(f.perm)}var Zt=[{group:"Catalogue"'],
];

// The sidebar gating touches five places that must agree on the minified names of the nav list and the identity.
// So it is ONE all-or-nothing step that reads those names from the bundle instead of assuming them. If anything
// does not line up (a different console build) the whole step is skipped and the console behaves as before;
// it can never be half-applied. The injected code is also wrapped so that a mistake can only ever mean "show the
// section", never a blocked screen.
export function gateNav(js) {
  const list = /var (\w+)=\[\{group:"Catalogue",items:\[/.exec(js)?.[1];
  const ident = /function \w+\(\{[^}]*identity:(\w+)\}\)\{/.exec(js)?.[1];
  if (!list || !ident) return null;
  const sidebarFrom = `e("nav",{class:"sidebar-nav","aria-label":"Sections"},${list}.map(h=>e("div",{class:"nav-group"},e("h2",{class:"nav-group-title",text:h.group}),e("ul",{class:"nav-list"},h.items.map(f=>{`;
  const routeFrom = "{content:r,toolbar:u,titleFor(h){";
  const steps = [
    ['{id:"media",label:"Media"}', '{id:"media",label:"Media",perm:"media.view"}'],
    ['{id:"blocks",label:"Blocked"}', '{id:"blocks",label:"Blocked",perm:"blocks.manage"}'],
    ['{id:"discounts",label:"Discount tiers"},{id:"payment",label:"Payment rules"}', '{id:"discounts",label:"Discount tiers",perm:"settings.manage"},{id:"payment",label:"Payment rules",perm:"settings.manage"}'],
    [sidebarFrom, sidebarFrom.replace(`${list}.map(h=>e(`, `${list}.map(h=>({...h,items:h.items.filter(f=>__aaAllowed(${ident},f))})).filter(h=>h.items.length).map(h=>e(`)],
    [routeFrom, `{isHidden:h=>{try{let f=${list}.flatMap(g=>g.items).find(g=>g.id===h);return!!f&&!__aaAllowed(${ident},f)}catch{return!1}},firstVisible:()=>{try{let f=${list}.flatMap(g=>g.items).find(g=>__aaAllowed(${ident},g));return f&&f.id}catch{return void 0}},content:r,toolbar:u,titleFor(h){`],
    [`var ${list}=[{group:"Catalogue"`, `function __aaAllowed(i,f){try{return!f.perm||!i||i.role==="admin"||!Array.isArray(i.v2perms)||i.v2perms.includes(f.perm)}catch{return!0}}var ${list}=[{group:"Catalogue"`],
  ];
  let out = js;
  for (const [from, to] of steps) {
    if (out.includes(to)) continue;                                  // already applied
    if (count(out, from) !== 1) return null;                         // does not line up: apply nothing
    out = out.replace(from, () => to);
  }
  return out;
}

export function patchConsoleJs(js) {
  let out = js.replace(/^\/\*console-fixes(?:-v1)?\*\//, "");
  for (const p of PATCHES) {
    if (out.includes(p.to)) continue;                       // already applied
    const n = count(out, p.from);
    // Never ambiguous: two matches would mean patching the wrong place. No match is allowed, so a console build
    // that already contains a fix natively is left alone (the browser tests still prove the behaviour).
    if (n > 1) throw new Error(`console patch "${p.id}": expected at most 1 match, found ${n}`);
    if (n === 1) out = out.replace(p.from, () => p.to);
  }
  for (const [from, to] of LEGACY_NAV) if (out.includes(to)) out = out.replace(to, () => from);
  const gated = gateNav(out);
  if (gated) out = gated;
  // The new-order script is always the last block: replaced wholesale so an edited script reaches the bundle.
  const at = out.indexOf(NEW_ORDER_MARK);
  if (at >= 0) out = out.slice(0, at).replace(/\n$/, "");
  out += `\n${NEW_ORDER_MARK}\n${NEW_ORDER_SOURCE}`;
  return PATCH_MARK + out;
}
