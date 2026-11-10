// Fixes for the admin console bundle (built by dodumodu_site, not part of this repository).
// Each patch replaces one exact, unique piece of the minified bundle and fails loudly if the bundle no longer
// contains it, so a future console build can never be half-patched silently. Applying is idempotent.
//
//  1. table-empty-state : the shared table helper (Y) returned the "empty" panel whenever an `empty` option was
//     passed, even when rows existed, so Users and Auth log never listed anything. The empty panel is now
//     shown only when there are no rows, and a plain string `empty` is accepted as the title.
//  2. identity-permissions : the console read its permission list from `perms` of /auth/me (the new-style keys,
//     empty for the legacy ones) so every "Add"/"Upload" control gated on products:write, categories:write,
//     media:write, testimonials... stayed hidden. It now prefers the `permissions` list /auth/me returns.
//  3. clear-toolbar : the page toolbar (where Users puts "+ Add user") was not cleared on navigation, so the
//     button leaked onto unrelated sections until a refresh.
//  4. route-scoped-shell : a view that finishes loading after the operator has moved on wrote its toolbar and
//     content into the NEW section. Each route now gets a shell whose targets are detached once it is stale.
export const PATCH_MARK = "/*console-fixes-v1*/";

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

export function patchConsoleJs(js) {
  if (js.includes(PATCH_MARK)) return js;
  let out = js;
  for (const p of PATCHES) {
    const n = count(out, p.from);
    if (n > 1) throw new Error(`console patch "${p.id}": expected at most 1 match, found ${n}`);
    out = out.replace(p.from, () => p.to);
  }
  return PATCH_MARK + out;
}
