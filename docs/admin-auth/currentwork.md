dodumodu-commerce/dodumodu_backend/src/app.ts‎


Now I have the wiring. The critical bypass question: does the existing /admin/* route (line 102, adminRoute — Cloudflare-Access guarded) have a /* guard or catch-all that would intercept my new /admin/sign-in/? I must read it before touching routing.

Cline read 3 files:

C:/Users/user/Documents/Automation/dodumodu-commerce/dodumodu_backend/src/routes/admin.ts‎

C:/Users/user/Documents/Automation/dodumodu-commerce/dodumodu_backend/src/auth-ui/login.html‎

C:/Users/user/Documents/Automation/dodumodu-commerce/dodumodu_backend/src/auth-ui/auth.js‎


I have the full routing picture. Stopping the recon loop now — here's the definitive plan. No more reads.

Current state
Admin console pages (/admin/, /admin/sessions/, /admin/devices/) are static HTML served from dodumodu_site/dist/admin/ by mountStatic. Static files cannot be guarded — that's the bypass: anyone hitting /admin/ with JS disabled or by direct URL gets the page shell.
Login UI lives at src/auth-ui/ (login.html + auth.js), copied to dist/auth-ui/ by bundle.mjs; currently reachable at /auth-ui/login.html.
APIs are already correctly gated: /auth/* (login flow) and /admin-v2/* (requireSession/requireAdmin/requirePerm). The admin HTML is the only unguarded surface.
There's an existing /admin/* API route (src/routes/admin.ts, Cloudflare-Access guarded) mounted in app.ts. I must confirm in Act mode whether it's a catch-all that would shadow /admin/sign-in/; my plan is collision-proof regardless (see A).
Plan (admin-focused, no public /sign-in)
A. Server-side page guard (the anti-bypass core). A guardAdminPages middleware in node.ts, ordered after the /auth + /admin-v2 API mounts and before mountStatic. It intercepts GET /admin/* document requests (Accept: text/html, not the API):

/admin/sign-in/ → public, serve login HTML (no redirect loop).
/admin/, /admin/sessions/, /admin/devices/ → read __Host-sid, run the same session resolution the API uses (lookupSession + role/idle/tier enforcement). Valid admin → serve the static page. Invalid/expired/missing → 302 → /admin/sign-in/.
Because it's a server 302, disabling JS or curling directly cannot bypass it (unlike a client-side redirect).
B. Sign-in at /admin/sign-in/ only. The page route serves login.html there. No /sign-in/ route is created (per your instruction). Login HTML/JS/CSS move out of the auth-ui/ prefix.

C. Remove the auth-ui/ route. Delete the auth-ui → dist/auth-ui copy step in bundle.mjs; stop serving that prefix (it'll 404). Assets (auth.js, sessions.js, devices.js, auth.css) are served from the admin page paths (external files only — CSP forbids inline per §5.9).

D. Post-login redirect. finishLogin() already targets /admin/; I'll keep that and ensure it's same-origin (no open redirect). Arriving at /admin/sign-in/ returns to /admin/.

E. Collision safety. If the existing /admin/* API adminRoute is a catch-all, I'll scope my page guard + /admin/sign-in/ ahead of it and confirm /admin-v2/* (auth API) is untouched, so neither the Cloudflare-Access API nor the new guard is bypassed.

F. Rebuild + verify (live, curl).

No cookie: /admin/, /admin/sessions/, /admin/devices/ → 302 → /admin/sign-in/.
No cookie: /auth-ui/login.html → 404 (prefix gone).
/admin/sign-in/ → 200 login page.
Full staff + admin login through Playwright → lands on /admin/; API calls without session → 401/403.
Commit.
Operator-only, flagged: everything runs against the local dev DB + local build. No production.

One Act-mode verification before editing (A/E): whether adminRoute is a /* catch-all so I place the guard and /admin/sign-in/ where they can't be shadowed.