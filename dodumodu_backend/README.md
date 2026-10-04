# skincare-backend

Hono API for the skincare ads funnel. It runs unchanged on two runtimes:

| | Local | Production |
| --- | --- | --- |
| Entry point | `src/node.ts` (Node) | `src/index.ts` (Cloudflare Workers) |
| Database | local PostgreSQL via `pg` | Neon via `@neondatabase/serverless` |
| R2 / KV | local stand-ins in `src/node/shims.ts` | real bindings |

The repository root README has the full setup, the configuration table and the
Cloudflare deployment steps. This file is the "how this package is put together"
cheat sheet.

## Layout

```
src/
  app.ts          every route, no runtime in it — both entry points import it
  index.ts        Worker entry (wrangler `main`): registers the Neon driver
  node.ts         local Node entry: env, pg driver, shims, static file server
  db.ts           the only place a connection is decided (driver registry)
  dbDrivers/      neon.ts (Worker) | pg.ts (Node)
  node/           LOCAL ONLY: shims, static server, .env loader, path guard
  routes/ services/ data/ external/ validation/   shared, runtime-agnostic
migrations/       the only schema history — identical in both environments
scripts/seed.mjs  optional demo data (idempotent; not a migration)
```

Switching environments switches the entry point and the configuration. Routes,
services, repositories, the schema and the frontend are untouched.

## Commands

```bash
npm run dev            # tsx watch src/node.ts — API + built site + media, one port
npm run dev:worker     # wrangler dev — production configuration, locally
npm run db:status      # is the local database up?
npm run db:start       # start it (db:init creates it the first time, db:stop stops it)
npm run db:migrate     # apply pending migrations/*.sql to DATABASE_URL (local or Neon)
npm run db:seed        # demo product/images/testimonials, safe to re-run
npm run db:generate    # after editing src/schema.ts
npm test               # unit tests (see below)
npm run typecheck
npm run deploy         # wrangler deploy
```

`db:start` / `db:stop` / `db:status` / `db:init` are thin wrappers around
`scripts/local-db.ps1`, which drives the PostgreSQL installed on this machine
against `%LOCALAPPDATA%\dodumodu-pg\data` on port 55432. Nothing in the
application code starts or stops a database; this is purely a developer
convenience and is never imported by the app.

`db:migrate` records applied files in a `schema_migrations` table and skips them,
so re-running it is a no-op — locally, and in a deploy pipeline against Neon
where it will run again on every deploy. `db:baseline` records the existing
files without running them, for a database that predates that table.

## Tests

```bash
npm test
```

- `services/*.test.ts` — delivery cutoff/fees, discounts, COD policy, order
  creation.
- `app.test.ts` — the CORS allowlist (exact origins and `*.pages.dev`).
- `node/mediaPath.test.ts` — the local file server's path guard: traversal,
  encoded traversal, absolute paths, drive letters, backslashes, null bytes,
  symlinks, and the write path used by the R2 stand-in.
- `isolation.test.ts` — walks the real import graph from `src/index.ts` and
  fails if any local module or Node-only package became reachable from the
  Worker. This is what keeps `pg` and the shims out of the production bundle.

## Layer rule (don't break this)

`routes/` → `services/` → `data/` (repos) or `external/` (OPay, R2). Nothing
skips a layer. `db.ts` (with `dbDrivers/`) is the only place a DB connection is
made; `opayClient.ts` is the only file that calls OPay; each `*Repo.ts` is the
only file that touches its table(s).

Local-only code (`src/node.ts`, `src/node/**`, `dbDrivers/pg.ts`) must never be
imported from `app.ts`, `index.ts` or anything they reach — `isolation.test.ts`
enforces it.

## Configuration in production

`wrangler.toml` `[vars]`:

```toml
ENVIRONMENT = "production"                                   # also fails Turnstile closed
OPAY_BASE_URL = "https://api.opaycheckout.com"
ALLOWED_ORIGINS = "https://yourdomain.com,https://yourproject.pages.dev"
```

`wrangler secret put`: `DATABASE_URL`, `OPAY_PUBLIC_KEY`, `OPAY_SECRET_KEY`,
`OPAY_MERCHANT_ID`, `OPAY_WEBHOOK_SECRET`, `TURNSTILE_SECRET_KEY`,
`RECONCILE_CRON_SECRET`.

## cron-job.org

Point a job at `POST https://<your-worker>/reconcile-pending` every 5 minutes,
with header `x-cron-secret: <RECONCILE_CRON_SECRET>`.

## Local-only behaviour worth knowing

- With no `TURNSTILE_SECRET_KEY`, bot verification is skipped (non-production
  only) and the storefront skips the widget, so an order can be placed fully
  offline. With `ENVIRONMENT=production` a missing secret fails **closed**.
- `/admin/*` is open locally, because there is no Cloudflare Access in front of
  it; the local entry supplies the identity header Access would. Every admin
  route still checks that header, so this is a local affordance, not a way in.
- The rate limiter and R2 stand-in are per-process. Restarting the dev server
  resets the counters — that is the intended difference from KV/R2.

## What's in V2

- Orders carry `quantity` and a full price breakdown (`unitPrice`, `subtotal`,
  `discountPercent`, `discountAmount`, `amount`) — all server-computed, all
  snapshotted at order time (§8.7). Past orders never change when tiers change.
- Discount tiers live in the `discount_tiers` table, editable from
  `GET`/`PUT /admin/discount-tiers` — no redeploy needed to change 10/20/25% etc.
- `MAX_ORDER_QUANTITY` (a config var) is the hard server-side ceiling,
  independent of anything the client sends or disables.

## Pay on delivery is gated (migration 0002)

Run `npm run db:migrate` before deploying the worker, or every order read hits a
missing table.

Pay on delivery is a privilege decided by two numbers in the `payment_rules`
table (one row, `id = 1`):

| Column | Meaning |
| --- | --- |
| `cod_states` | States where a customer may choose pay on delivery at all. Seeded `Lagos, Ogun, Enugu, Abuja`. |
| `cod_bulk_threshold` | The **first bulk quantity**. Seeded `5`, so quantities 1-4 may pay on delivery and 5 or more must pay before dispatch. Set `1` to switch COD off everywhere. |

- Edit them from the admin panel's "Payment rules" tab (`GET`/`PUT
  /admin/payment-rules`). Saving takes effect on the next order, with no redeploy.
- `GET /page-data/:slug` publishes them as `paymentRules`, so the storefront
  greys the option out and explains why before submit. The browser copy is
  presentation only: `orderService.createOrder` re-runs the same decision and
  answers `400` with `fields.paymentMethod` for anything it disagrees with.
- State matching is normalised (`nigeriaStates.ts`), so "lagos", "Lagos State"
  and "LAGOS" are one place, and "Abuja" and "FCT" are one place. Without this a
  customer silently loses (or keeps) COD on spelling alone.
- A **missing** rules row fails *closed* (`CLOSED_PAYMENT_RULES`: no states, no
  quantities) rather than open. A database problem must never turn into a street
  of uncollected deliveries.
- An order is judged once, at creation. A duplicate retry returns the original
  order above this check, and rules changed later never re-judge it (§8.7).
- `codPolicyService.ts` (server) and `shared/scripts/codRules.js` (browser) are
  deliberate mirrors: same comparison, same ceiling arithmetic, same sentences.
  `dodumodu_site/test/form-ux.check.mjs` fails if the two ever drift, because a
  customer shown one message and then refused with another is a support ticket.

## Before going to production

- Confirm the exact OPay checkout-creation and webhook payload field names
  against OPay's *current* docs — `opayClient.ts` has the shape but the field
  names are placeholders pending that check.
- Wire the §5.11 alert (Slack webhook / email / WhatsApp) into the two `TODO`s
  in `routes/payments.ts`.
- Set `ALLOWED_ORIGINS` to the real Pages domain and put Cloudflare Access in
  front of `/admin/*`.

