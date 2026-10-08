# DODUMODU — skincare store

One codebase that runs in two places:

| | Local development | Production |
| --- | --- | --- |
| API runtime | Node (`@hono/node-server`) | Cloudflare Workers |
| Database | PostgreSQL on your machine | Neon |
| DB driver | `pg` (TCP) | Neon's HTTP driver |
| Media | a directory (`.media/`) | R2 |
| Rate limiting | an in-memory Map | Workers KV |
| Site | served by the same dev server | Cloudflare Pages |
| Configuration | `.env` at the repository root | wrangler vars/secrets + Pages env vars |

**Only configuration changes between the two.** The application source, the
database schema, the business logic and the frontend source are identical — same
repository, same build, same migrations.

```
dodumodu/
├── .env                 # your local config (git-ignored, never committed)
├── .env.example         # every key, documented — copy this to .env
├── dodumodu_backend/    # Hono API (Worker + local Node entry points)
└── dodumodu_site/       # storefront (static build, no framework)
```

## Quick start (local)

```bash
# 1. Configure — one file for both packages
cp .env.example .env

# 2. Install
cd dodumodu_backend && npm install && cd ..
cd dodumodu_site    && npm install && cd ..

# 3. Database: create it once, then start it (see "Local database")
cd dodumodu_backend
npm run db:init         # only the first time: creates the cluster + database
npm run db:start        # every time: starts it
npm run db:status       # is it up?

# 4. Schema and a little data to look at
npm run db:migrate
npm run db:seed         # demo product, images, testimonials — optional, idempotent
cd ..

# 5. Build the site, then run everything on one port
cd dodumodu_site && npm run build && cd ..
cd dodumodu_backend && npm run dev
```

Open <http://localhost:8787/> — that single server serves the storefront, the
API and any uploaded media. `http://localhost:8787/admin/` is the admin panel.

Nothing else is needed for a full offline flow: pay on delivery works, and with
no Turnstile secret configured the order form skips the challenge rather than
loading a script that cannot be solved.

**After a reboot, run `npm run db:start` again.** The database is a data
directory started on demand rather than a Windows service, so the data survives
but the process does not.

### Local database

Any PostgreSQL 15+ you have installed will do — `scripts/local-db.ps1` finds it
under `C:\Program Files\PostgreSQL\*` and matches the version to the cluster
(15 and 18 can coexist on one machine; only the matching major version can open
a given data directory). Set `LOCAL_PG_BIN` to point it somewhere else.

```powershell
cd dodumodu_backend
npm run db:init      # once: create the cluster and the dodumodu database
npm run db:start     # start it
npm run db:status    # report whether it is up and reachable
npm run db:stop      # graceful shutdown
```

The cluster lives in `%LOCALAPPDATA%\dodumodu-pg\data`, logs to
`%LOCALAPPDATA%\dodumodu-pg\server.log`, and listens on **port 55432** bound to
localhost only — never 5432, which usually belongs to the Windows service
installation. `.env` already points at it:

```dotenv
DATABASE_URL=postgresql://postgres@localhost:55432/dodumodu
```

The same migrations and the same `db:migrate` script then run against Neon —
only the URL changes. `db:migrate` records what it applied in a
`schema_migrations` table, so it is safe to re-run (locally and in a deploy
pipeline). If you ever point it at a database that was migrated before that
table existed, `npm run db:baseline` records the existing migrations as applied
without running them.

## How the two runtimes stay separate

```
PRODUCTION  wrangler (main: src/index.ts)
  index.ts ──> app.ts ──> routes ──> services ──> data ──> db.ts ──> dbDrivers/neon.ts

LOCAL       node (src/node.ts)
  node.ts ──> app.ts ──> routes ──> services ──> data ──> db.ts ──> dbDrivers/pg.ts
           └─> node/shims.ts     (R2 → directory, KV → Map)
           └─> node/static.ts    (serves .media/ and the built site)
```

- `src/app.ts` holds every route and has no runtime in it. Both entry points
  import the same app.
- `src/db.ts` is a driver registry: the entry point registers `neonDriver` or
  `pgDriver`, and `createDb(url)` is the only thing repositories see. Both
  drivers are the same Drizzle pg-core query builder over the same schema.
- `src/node/**` is local-only. It is unreachable from `src/index.ts`, so `pg`
  and the shims are absent from the Worker bundle — enforced by a test
  (`npm test` → `src/isolation.test.ts`), not by convention.
- The shims refuse to start with `ENVIRONMENT=production`, so a misconfigured
  `.env` can never run the local stand-ins against production traffic.

## Configuration

Every environment-specific value is a variable. Real environment variables
always take precedence over `.env`, so one-off overrides work:

```bash
DATABASE_URL=postgresql://other-host/db npm run db:migrate
```

**Frontend (build time)** — read by `dodumodu_site/build/bundle.mjs`:

| Variable | Purpose |
| --- | --- |
| `SITE_URL` | canonical link, `og:url`, JSON-LD, sitemap, robots |
| `API_BASE` | API origin; **empty means same origin** (local, or a Worker route) |
| `IMAGE_DELIVERY_BASE` | media origin/path — `/media` locally, the R2 domain in production |
| `TURNSTILE_SITE_KEY` | public widget key; empty disables the widget (local only) |
| `PLACEHOLDER_IMAGE_BASE` | placeholder imagery for the hero/testimonials |

**Backend (runtime)** — `.env` locally, wrangler in production:

| Variable | Where it comes from in production |
| --- | --- |
| `DATABASE_URL` | `wrangler secret put` (Neon) |
| `ENVIRONMENT` | `wrangler.toml` `[vars]` |
| `ALLOWED_ORIGINS` | `wrangler.toml` `[vars]` — comma-separated CORS allowlist |
| `OPAY_BASE_URL` | `wrangler.toml` `[vars]` (sandbox or production host) |
| `RATE_LIMIT_*`, `MAX_ORDER_QUANTITY`, `R2_BUCKET_NAME` | `wrangler.toml` `[vars]` |
| `OPAY_*`, `TURNSTILE_SECRET_KEY`, `RECONCILE_CRON_SECRET` | `wrangler secret put` |

No secret is ever compiled into the site: the two values injected into the HTML
(`API_BASE`, `IMAGE_DELIVERY_BASE`) are public by definition.

## Deploying to Cloudflare

### 1. One-time account setup

```bash
cd dodumodu_backend
wrangler login
wrangler r2 bucket create skincare-media
wrangler kv namespace create RATE_LIMIT_KV      # paste the id into wrangler.toml
```

### 2. Secrets (never in git)

```bash
wrangler secret put DATABASE_URL          # Neon connection string (pooled)
wrangler secret put OPAY_PUBLIC_KEY
wrangler secret put OPAY_SECRET_KEY
wrangler secret put OPAY_MERCHANT_ID
wrangler secret put OPAY_WEBHOOK_SECRET
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put RECONCILE_CRON_SECRET
```

### 3. Vars

In `wrangler.toml` `[vars]`, set for production:

```toml
ENVIRONMENT = "production"
OPAY_BASE_URL = "https://api.opaycheckout.com"
ALLOWED_ORIGINS = "https://yourdomain.com,https://yourproject.pages.dev"
```

### 4. Database

```bash
DATABASE_URL=<neon-url> npm run db:migrate      # same script, same .sql files
DATABASE_URL=<neon-url> npm run db:seed         # optional first product
```

### 5. Deploy

```bash
npm run deploy
```

Then schedule a job (cron-job.org) for
`POST https://<your-worker>/reconcile-pending` every 5 minutes with header
`x-cron-secret: <RECONCILE_CRON_SECRET>`.

Schedule a second job for
`POST https://<your-worker>/internal/monthly-kpi-snapshots/close` once daily
after midnight in Africa/Lagos, with the same `x-cron-secret` header. The endpoint
captures the previous Lagos month once and never overwrites an existing snapshot.

### 6. Site (Cloudflare Pages)

- Build command: `cd dodumodu_site && npm ci && npm run build`
- Output directory: `dodumodu_site/dist`
- Environment variables: `SITE_URL`, `API_BASE` (set it to the Worker origin if
  the site is on a different domain), `IMAGE_DELIVERY_BASE` (the R2 custom
  domain), `TURNSTILE_SITE_KEY`, and `PLACEHOLDER_IMAGE_BASE` while the
  placeholder imagery is still in place.

### 7. Remaining Cloudflare pieces

- **R2 delivery**: attach a custom domain to the bucket (optionally behind
  Cloudflare Image Transformations) and set it as `IMAGE_DELIVERY_BASE`.
- **Turnstile**: create a widget for your domain(s) in the dashboard; put the
  site key in Pages and the secret key in the Worker.
- **OPay**: point the merchant's webhook at `https://<your-worker>/opay-webhook`
  and use the live keys plus the production `OPAY_BASE_URL`.
- **Access**: put Cloudflare Access in front of `/admin/*` — every admin route
  checks the identity header Access supplies, and refuses without it.

To rehearse production configuration locally, use `npm run dev:worker`
(wrangler's local runtime) rather than pointing the Node entry point at
production values.

## Commands

```bash
# dodumodu_backend
npm run dev            # local Node server: API + built site + media, one port
npm run dev:worker     # wrangler's local runtime (rehearses production config)
npm run db:migrate     # apply migrations/*.sql to DATABASE_URL
npm run db:seed        # optional demo data (idempotent)
npm run db:generate    # regenerate a migration after editing src/schema.ts
npm test               # unit tests, incl. CORS allowlist, media path guard, isolation
npm run typecheck
npm run deploy         # wrangler deploy

# dodumodu_site
npm run build          # dist/, with build-time values injected
npm test               # build, then form UX + CSS single source + size budget + pricing smoke
npm run test:css       # rebuild and prove the page's CSS comes only from shared/styles
```

## Checks

```bash
cd dodumodu_backend && npm test        # services, CORS allowlist, media path guard, isolation
cd dodumodu_backend && npm run typecheck
cd dodumodu_site    && npm test        # form UX, CSS single source, size budget, pricing smoke
```

## Security notes

- CORS is an explicit allowlist (`ALLOWED_ORIGINS`), never `*`.
- The local file server resolves and then proves every path is inside its root
  (`dodumodu_backend/src/node/mediaPath.ts`) — `..`, encoded traversal,
  absolute paths, backslashes, null bytes and symlinks are all refused, and
  failures answer 404 so a probe learns nothing.
- Upload filenames are reduced to a safe character set before becoming a
  storage key.
- Turnstile fails **closed** in production; it is only skipped locally.



