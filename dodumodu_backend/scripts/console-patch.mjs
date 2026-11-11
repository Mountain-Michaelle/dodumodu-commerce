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
  {
    id: "nav-permissions",
    from: '{id:"media",label:"Media"}]}',
    to: '{id:"media",label:"Media",perm:"media.view"}]}',
  },
  {
    id: "nav-permissions-blocked",
    from: '{id:"blocks",label:"Blocked"}',
    to: '{id:"blocks",label:"Blocked",perm:"blocks.manage"}',
  },
  {
    id: "nav-permissions-settings",
    from: '{id:"discounts",label:"Discount tiers"},{id:"payment",label:"Payment rules"}',
    to: '{id:"discounts",label:"Discount tiers",perm:"settings.manage"},{id:"payment",label:"Payment rules",perm:"settings.manage"}',
  },
  {
    id: "nav-gating-list",
    from: 'n=e("nav",{class:"sidebar-nav","aria-label":"Sections"},Zt.map(h=>e("div",{class:"nav-group"},e("h2",{class:"nav-group-title",text:h.group}),e("ul",{class:"nav-list"},h.items.map(f=>{',
    to: 'n=e("nav",{class:"sidebar-nav","aria-label":"Sections"},Zt.map(h=>({...h,items:h.items.filter(f=>__aaAllowed(t,f))})).filter(h=>h.items.length).map(h=>e("div",{class:"nav-group"},e("h2",{class:"nav-group-title",text:h.group}),e("ul",{class:"nav-list"},h.items.map(f=>{',
  },
  {
    id: "nav-gating-route",
    from: '{content:r,toolbar:u,titleFor(h){',
    to: '{isHidden:h=>{let f=Zt.flatMap(g=>g.items).find(g=>g.id===h);return!!f&&!__aaAllowed(t,f)},firstVisible:()=>{let f=Zt.flatMap(g=>g.items).find(g=>__aaAllowed(t,g));return f&&f.id},content:r,toolbar:u,titleFor(h){',
  },
  {
    id: "nav-gating-helper",
    from: 'var Zt=[{group:"Catalogue"',
    to: 'function __aaAllowed(i,f){return!f.perm||!i||i.role==="admin"||!Array.isArray(i.v2perms)||i.v2perms.includes(f.perm)}var Zt=[{group:"Catalogue"',
  },
];

const count = (s, needle) => s.split(needle).length - 1;

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
  // The new-order script is always the last block: replaced wholesale so an edited script reaches the bundle.
  const at = out.indexOf(NEW_ORDER_MARK);
  if (at >= 0) out = out.slice(0, at).replace(/\n$/, "");
  out += `\n${NEW_ORDER_MARK}\n${NEW_ORDER_SOURCE}`;
  return PATCH_MARK + out;
}
