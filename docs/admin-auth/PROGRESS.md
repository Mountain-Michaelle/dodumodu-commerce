# PROGRESS — admin auth (ADMIN_AUTH_V2)

Branch: `feat/admin-auth`. Spec: `docs/admin-auth/IMPLEMENT.md` (see "open items" — file not yet persisted).

## Phase 0 — baseline + recon (Run 1.1)

- Commit: (phase 0 has no code changes yet)
- Baseline test counts: **404 tests, 385 pass, 2 fail, 17 skipped, 0 cancelled** (`npx tsx --test <all src/**/*.test.ts>`; the `npm test` glob `src/**/*.test.ts` does not expand under this Windows/PowerShell shell, so tests were enumerated explicitly).
- Pre-existing failures (NOT fixed, per spec §2.7):
  - `not ok 146` public visit writes one HMAC visitor-day and contains no raw IP — `src/routes/visitorAnalytics.test.ts:59` (0 !== 1)
  - `not ok 147` duplicate visit requests are throttled without another database write — `src/routes/visitorAnalytics.test.ts:71` (0 !== 1)

### Recon note (≤20 lines)

1. DB calls: Drizzle ORM via `createDb(env.DATABASE_URL)` per request; drivers `neon-http` (Worker) / `node-postgres` (Node). Raw SQL possible with `db.execute(sql\`...\`)` on both.
2. `transaction([...])` in app code: NOT used anywhere. neon-http has no transaction support — the two-statement transactions (E4 `PHRASE_RESET_CREATE`, F3 `DEVICE_INVITE_CREATE`) will be implemented as single PL/pgSQL functions (one statement = atomic) in the migration.
3. Cookies: none set today; new code will use `hono/cookie` (`getCookie`/`setCookie`) inside per-route chains only.
4. Existing admin guard: `resolvePrincipal` in `src/auth/adminAuth.ts`, reading `cf-access-authenticated-user-email`, applied ONCE in `src/routes/admin.ts` via `adminRoute.use("*")`. Left untouched.
5. Migration tool: hand-written numbered SQL `dodumodu_backend/migrations/NNNN_*.sql` applied by `npm run db:migrate` (`migrations/migrate.ts`, tracks `schema_migrations`, one tx per file). Next free number: **0017**.
6. Test runner: `npm test` = `tsx --test src/**/*.test.ts` (node:test). Colocated `*.test.ts`.
7. UI folder: `dodumodu_site/` (vanilla JS in `shared/scripts`, views in `shared/scripts/admin/views`). New auth UI goes in backend `src/auth-ui/` and is served by the Worker under `/auth/ui/*` (spec constraint 4).
8. CI: **none** — no `.github/`, no `*.yml`/`*.yaml` anywhere in the repo. Nothing runs migrations or deploys on push. (Report only; not edited.)
9. Route collisions: no `/auth/*` routes exist; no `/admin/users*` or `/admin/devices*` routes exist. Existing `/admin/*` resource routes are untouched; `AUTH_BASE=/auth`, `ADMIN_BASE=/admin` stay as specified.
10. `aa_` grep: no hits. `pg_advisory` grep: no hits → keys 7001/7002 free as-is.
11. Scheduler: cron-job.org already POSTs `/reconcile-pending` and `/internal/monthly-kpi-snapshots/close` with `x-cron-secret: RECONCILE_CRON_SECRET`; auth cleanup will follow that pattern as a NEW route.
12. wrangler.toml already has `nodejs_compat` (pre-existing; not added by us, not removed).

### Operator prerequisites (unknown — flagged, not verified by Cline)

- Workers **Paid** plan needed for Argon2id CPU — not verifiable from the repo.
- Cloudflare Access `/auth/*` bypass — operator-side.
- `.dev.vars` secrets (OTP_KEY, THROTTLE_KEY, TOTP_ENC_KEY, RESEND_API_KEY, TURNSTILE_SECRET, DATABASE_URL dev branch) — operator supplies real values.

## Open items

- [ ] Persist the spec verbatim at `docs/admin-auth/IMPLEMENT.md` (provided in-session; not yet written to disk).
