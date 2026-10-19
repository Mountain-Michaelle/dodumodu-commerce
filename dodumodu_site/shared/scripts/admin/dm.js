/* admin/dm.js — vanilla, dependency-free.
 *
 * Loaded two ways, both supported:
 *   1. As an ES module inside the esbuild admin bundle (admin.js imports it).
 *   2. As a plain <script> global (window.dm), e.g. a future login page.
 *
 * The IIFE body defines the state machine ONCE per realm; the exports below
 * re-entrant-reference it. Never duplicate this file's guts elsewhere.
 */
const _dm = (() => {
  const d = typeof document !== "undefined" ? document : null;
  const w = typeof window !== "undefined" ? window : globalThis;
  let n = 0, t = null, h = null, at = 0;
  const el = () => (d ? d.getElementById("dm-splash") : null);
  const bar = (on) => { const s = d ? d.querySelector("[data-dm-bar]") : null; if (s) s.classList.toggle("dm-run", !!on); };
  // 200 ms delay before showing (kills flicker), 400 ms minimum display,
  // 10 s CSS safety timer (data-boot) in case JS errors — per the guide.
  const api = {
    track(p) { n++; bar(1); const done = () => { if (!--n) bar(0); }; p.then(done, done); return p; },
    show() {
      clearTimeout(t); clearTimeout(h);
      t = setTimeout(() => { const s = el(); if (s) { s.hidden = false; at = Date.now(); } }, 200);
    },
    hide() {
      clearTimeout(t); const s = el(); if (!s) return;
      const left = at ? 400 - (Date.now() - at) : 0; clearTimeout(h);
      h = setTimeout(() => { s.hidden = true; s.removeAttribute("data-boot"); at = 0; }, left > 0 ? left : 0);
    },
  };
  if (w && !w.dm) w.dm = api;
  const s0 = el(); if (s0 && !s0.hidden) at = Date.now();
  return api;
})();

export const track = (p) => _dm.track(p);
export const show = () => _dm.show();
export const hide = () => _dm.hide();