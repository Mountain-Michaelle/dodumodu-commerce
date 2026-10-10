# Current Work — Admin Auth: guarded /admin/sign-in/ + no-bypass admin pages

Date: 2026-10-10 | Branch: feat/admin-auth | Spec: docs/admin-auth/IMPLEMENT.md

## Locked requirements
- Admin sign-in lives STRICTLY at /admin/sign-in/ (clean URL, no .html, no auth-ui/ prefix).
- NO public /sign-in/ route.
- REMOVE the /auth-ui/ route entirely (bundle copy step + serving).
- Server-side guard: no /admin/* page served without a valid session (server 302, not JS).

## The bypass (why this work exists)
- mountStatic(app, siteDist) serves dist/ with no session check, so dist/admin/index.html
  (console) and dist/auth-ui/login.html are reachable raw today.
- APIs are already gated correctly: /auth/* (login flow) and /admin-v2/*
  (requireSession/requireAdmin/requirePerm). Only the admin HTML surface is unguarded.
- Existing /admin/* API (src/routes/admin.ts, Cloudflare-Access guarded) must not be disturbed.

## Plan
A. Guarded static helper in src/node/static.ts: mountGuardedStatic(app, distDir, guard)
   reusing mountStatic resolution (MIME, traversal safety, clean-URL index.html) with a guard
   check first; fail => 302 to /admin/sign-in/.
B. Guarded page routes in src/node.ts AFTER /auth + /admin-v2 mounts and BEFORE mountStatic:
   - GET /admin/sign-in/ (public) => login HTML.
   - GET /admin, /admin/, /admin/sessions[/], /admin/devices[/] => __Host-sid via lookupSession
     (+ role/idle/tier enforcement); valid admin => serve static page; else 302 /admin/sign-in/.
   - GET /admin/assets/* => guarded JS/CSS (external files only, CSP forbids inline).
C. Remove auth-ui/ serving: delete auth-ui -> dist/auth-ui copy in
   dodumodu_site/build/bundle.mjs; /auth-ui/* then 404s.
D. UI redirect: finishLogin() defaults to /admin/, honoring same-origin ?next= only.
E. Collision safety: confirm adminRoute has no /* catch-all shadowing /admin/sign-in/;
   if it does, place guarded page routes before app.route('/admin', adminRoute).
F. Rebuild + verify live: /admin/sign-in/ => 200; /admin/, /admin/sessions/, /admin/devices/
   without cookie => 302 to /admin/sign-in/; /auth-ui/login.html => 404; APIs unchanged;
   full staff + admin login via Playwright lands on /admin/; tsc clean; commit + push.

## Test accounts (local dev DB)
- staff@example.com / phrase: correct-horse-battery-staple-99 (2 factors; code via
  /auth/test/mailbox/staff@example.com).
- admin2@example.com (first admin; device window open; enrolls phrase + TOTP + 8 backup
  codes on first login; code via /auth/test/mailbox/admin2@example.com).

## Operator note
- Local dev DB + local build only. No production access.
