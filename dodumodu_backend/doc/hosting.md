# Hosting — dodumodu-commerce on Cloudflare Worker + Neon

This guide takes the repo from local dev to a live Cloudflare Worker with a Neon Postgres database, R2 media storage, KV rate limiting, and admin-auth v2 (email OTP + TOTP).

## 1. Prerequisites

- Cloudflare account (paid plan recommended for Workers + R2 + KV)
- Neon account (https://console.neon.tech)
- Wrangler CLI: `npm install -g wrangler`
- Logged in: `wrangler login`
## 2. Neon database setup (production)

1. Go to https://console.neon.tech and create a new project.
2. Copy the **connection string** from the Neon dashboard (e.g. `postgresql://<user>:<pass>@ep-...region.aws.neon.tech/<dbname>?sslmode=require`).
3. This string is a **secret** — never commit it. Upload it via `wrangler secret put DATABASE_URL`.

The Worker uses `@neondatabase/serverless` (HTTP driver), so the standard Postgres connection string works.

### Run migrations against Neon

```powershell
$env:DATABASE_URL="postgresql://..."
npm run db:migrate
```

This applies all migrations (including `0017_admin_auth_aa.sql` and `0019_admin_auth_v2.sql` which create the `aa_*` admin-auth tables).

## 3. Cloudflare resources (R2 + KV)

## 4. Configure `wrangler.toml`

Edit `wrangler.toml` (repo root). Key changes:

| Setting | Action |
|---------|--------|
| `name` | Keep `skincare-backend` or rename |
| `main` | `src/index.ts` |
| `ADMIN_AUTH_V2` | Change `"0"` → `"1"` to enable email OTP + TOTP admin login |
| `IMAGE_DELIVERY_BASE` | Set to your R2 custom domain (or `/media`) |
| `ALLOWED_ORIGINS` | Your live domain(s), comma-separated, never `*` |
| `[[r2_buckets]]` | Already bound to `skincare-media` — keep |

Everything else under `[vars]` has safe defaults.

## 5. Upload secrets to Cloudflare

Secrets are never visible in `wrangler.toml`. Run each once:

```powershell
wrangler secret put DATABASE_URL
wrangler secret put OTP_KEY
wrangler secret put THROTTLE_KEY
wrangler secret put TOTP_ENC_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put TURNSTILE_SECRET
wrangler secret put AUTH_FROM_EMAIL
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put OPAY_PUBLIC_KEY
wrangler secret put OPAY_SECRET_KEY
wrangler secret put OPAY_MERCHANT_ID
wrangler secret put OPAY_WEBHOOK_SECRET
## 6. Build the admin site bundle

The Worker serves a pre-built admin frontend:

```powershell
npm run build:site
```

This writes `src/generated/site.ts` (inlined HTML/CSS/JS). Build before deploy.

## 7. Deploy

```powershell
wrangler deploy
```

Verify:

```powershell
curl https://<your-worker>.workers.dev/health
# expect: ok
```

## 8. Create the first admin user (bootstrap)

Run against Neon with `ADMIN_AUTH_V2=1` and secrets set:

```powershell
$env:DATABASE_URL="postgresql://..."
npm run createsuperuser -- admin@example.com --username=admin
```

It creates the first admin in `aa_users` with an open enroll window (atomic + idempotent-guarded). Then visit `/admin/` and complete: **email OTP → TOTP enroll → save backup codes → claim device**.

## 9. Navigation checklist

| Path | Purpose |
|------|---------|
| `/health` | Worker health check |
| `/` | Public storefront |
| `/admin/` | Admin sign-in (put Cloudflare Access in front in production) |
| `/auth/*` | Email OTP + TOTP admin-auth v2 flows |
| `/admin/orders` | Order management |
| `/admin/products` | Catalogue |
| `/admin/media` | R2 uploads |

## 10. Required environment summary

**Secrets** (`wrangler secret put <NAME>`):
```
DATABASE_URL
OTP_KEY, THROTTLE_KEY, TOTP_ENC_KEY   (base64, 32 bytes each, distinct)
RESEND_API_KEY, TURNSTILE_SECRET, AUTH_FROM_EMAIL
TURNSTILE_SECRET_KEY
OPAY_PUBLIC_KEY, OPAY_SECRET_KEY, OPAY_MERCHANT_ID, OPAY_WEBHOOK_SECRET
RECONCILE_CRON_SECRET, ANALYTICS_IP_HMAC_SECRET
```

**Vars** (`[vars]` in wrangler.toml):
```
ADMIN_AUTH_V2 = "1"
ENVIRONMENT = "production"
ALLOWED_ORIGINS = "https://yoursite.com,..."
R2_BUCKET_NAME = "skincare-media"
IMAGE_DELIVERY_BASE = "https://media.yoursite.com"
RATE_LIMIT_API_PER_MINUTE, RATE_LIMIT_ADMIN_PER_MINUTE, RATE_LIMIT_ADMIN_WRITES_PER_MINUTE
```

**Bindings** (`wrangler.toml`):
```
[[r2_buckets]]   binding = "MEDIA_BUCKET", bucket_name = "skincare-media"
[[kv_namespaces]] binding = "RATE_LIMIT_KV", id = "<real-id>"
```

## 11. Quick commands

```powershell
wrangler login
wrangler r2 bucket create skincare-media
wrangler kv:namespace create "RATE_LIMIT_KV"
wrangler secret put DATABASE_URL
wrangler secret put <each-secret>
npm run build:site
wrangler deploy
$env:DATABASE_URL="..."; npm run db:migrate
$env:DATABASE_URL="..."; npm run createsuperuser -- admin@example.com
wrangler secret list
wrangler tail   # live logs after deploy
```

wrangler secret put RECONCILE_CRON_SECRET
wrangler secret put ANALYTICS_IP_HMAC_SECRET
```

Each command prompts you to paste the value. Sources:
- **Neon dashboard** → `DATABASE_URL`
- **Resend** → `RESEND_API_KEY`, `AUTH_FROM_EMAIL` (verified sender)
- **Turnstile** → `TURNSTILE_SECRET` / `TURNSTILE_SECRET_KEY` (+ `TURNSTILE_SITE_KEY` frontend var)
- **OPay** → `OPAY_PUBLIC_KEY`, `OPAY_SECRET_KEY`, `OPAY_MERCHANT_ID`, `OPAY_WEBHOOK_SECRET`
- **OTP_KEY / THROTTLE_KEY / TOTP_ENC_KEY** → 32-byte base64 strings; must be distinct

Confirm: `wrangler secret list`

```powershell
wrangler r2 bucket create skincare-media
wrangler kv:namespace create "RATE_LIMIT_KV"
```

Take the KV namespace ID printed and put it in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "<REPLACE_WITH_REAL_KV_NAMESPACE_ID>"
```

## 12. Free Plan Production — Storefront (Cloudflare Pages) + Backend (Worker)

On the free plan you run **two separate services** in the same Cloudflare account:

| Service | Role | Free tier fit |
|---------|------|---------------|
| **Cloudflare Pages** | Storefront static HTML (prerendered product pages) | Free: unlimited requests, 100 GB bandwidth/mo, 500 builds/mo |
| **Cloudflare Workers** | API backend (`/api/*`, `/auth/*`, `/admin/*`) | Free: 100,000 requests/day, 10 ms CPU |
| **R2** | Product/media images | Free: 10 GB storage, 1M Class A ops, 10M Class B ops/mo |
| **KV** | Rate-limit counters | Free: 100,000 reads/day, 1,000 writes/day |
| **Neon** | Postgres database | Free: 0.5 GB storage, auto-hibernates after 5 min idle |

### 12.1 Prerender product pages for Pages

Your storefront lives in a sibling folder (`dodumodu_site` referenced in `src/node.ts`). It fetches products from the API and writes one HTML file per route, e.g. `/products/glow-serum/index.html`.

**Build locally (or in CI/CD):**

```powershell
# 1. Point the site builder at the live Worker API
$env:API_BASE="https://<your-worker>.workers.dev"
$env:SITE_URL="https://<your-pages-project>.pages.dev"

# 2. Run the site build (prerenders every product route)
cd ..\dodumodu_site
npm run build   # or whatever your site build script is
# output goes to dodumodu_site/dist
```

**Deploy to Pages:**

```powershell
wrangler pages deploy dodumodu_site/dist --project-name=<your-pages-project>
```

Pages will serve `index.html` for each product route automatically.

### 12.2 Wire frontend to the Worker API

In the storefront build, set these so the frontend calls your Worker (not localhost):

- `API_BASE=https://<your-worker>.workers.dev` — all `/api/*`, `/auth/*`, `/admin/*` calls
- `SITE_URL=https://<your-pages-project>.pages.dev` — canonical site URL
- `TURNSTILE_SITE_KEY=<from Turnstile dashboard>` — bot protection on checkout
- `IMAGE_DELIVERY_BASE=https://<your-r2-custom-domain>` or leave blank to proxy images through the Worker `/media/*` route

If `API_BASE` is empty the frontend calls same-origin (only works if Pages and Worker share a domain). On free plan they are separate subdomains, so **set `API_BASE` explicitly**.

### 12.3 R2 images on free plan (no custom domain)

R2 free tier does not always include a custom domain. Two options:

**Option A — Proxy media through the Worker** (simplest, uses Worker requests):
- `IMAGE_DELIVERY_BASE` left blank or set to the Worker URL
- Requests to `/media/<key>` are served by `mountMedia` in `src/node.ts` / Worker, pulling from R2
- Counts against your 100,000 Worker requests/day — fine for low traffic

**Option B — R2 custom domain** (if your account allows it on free tier):
- `wrangler r2 bucket domain create skincare-media`
- Set `IMAGE_DELIVERY_BASE=https://media.<yourdomain>` in both Pages env and Worker `wrangler.toml`

### 12.4 Environment variables per service

**Worker secrets** (`wrangler secret put` in backend repo):
```
DATABASE_URL          (Neon connection string)
OTP_KEY, THROTTLE_KEY, TOTP_ENC_KEY   (base64, 32 bytes, distinct)
RESEND_API_KEY, TURNSTILE_SECRET, AUTH_FROM_EMAIL
OPAY_PUBLIC_KEY, OPAY_SECRET_KEY, OPAY_MERCHANT_ID, OPAY_WEBHOOK_SECRET
RECONCILE_CRON_SECRET, ANALYTICS_IP_HMAC_SECRET
```

**Worker vars** (`wrangler.toml` `[vars]`):
```
ADMIN_AUTH_V2 = "1"
ENVIRONMENT = "production"
ALLOWED_ORIGINS = "https://<your-pages-project>.pages.dev"
```

**Pages env vars** (Cloudflare dashboard → Pages → your project → Settings → Environment variables → Production):
```
API_BASE=https://<your-worker>.workers.dev
SITE_URL=https://<your-pages-project>.pages.dev
TURNSTILE_SITE_KEY=<your-site-key>
IMAGE_DEPLOY_HOOK or IMAGE_DELIVERY_BASE=<optional R2 domain>
```

### 12.5 Cron (reconcile / KPI) on free plan

`wrangler.toml` may have a `[triggers] crons = []` entry. Workers free plan supports cron triggers (limited frequency). If you don't need scheduled reconciliation, omit or set `RECONCILE_CRON_SECRET` anyway — the cron route just won't be invoked.

### 12.6 Deploy order (do this once)

```powershell
# 1. Backend
wrangler login
wrangler r2 bucket create skincare-media
wrangler kv:namespace create "RATE_LIMIT_KV"   # paste ID into wrangler.toml
wrangler secret put DATABASE_URL
wrangler secret put <each secret from section 10>
npm run build:site
wrangler deploy

# 2. Bootstrap first admin against Neon
$env:DATABASE_URL="postgresql://..."
npm run createsuperuser -- admin@example.com --username=admin

# 3. Storefront
cd ..\dodumodu_site
$env:API_BASE="https://<your-worker>.workers.dev"
$env:SITE_URL="https://<your-pages-project>.pages.dev"
npm run build
wrangler pages deploy dist --project-name=<your-pages-project>
```

### 12.7 What to visit after deploy

- `https://<your-pages-project>.pages.dev/` — storefront
- `https://<your-worker>.workers.dev/health` — API health
- `https://<your-pages-project>.pages.dev/admin/` — admin sign-in (complete OTP → TOTP → backup codes → device)

**Free-plan watchouts:** Neon free tier hibernates after 5 minutes of inactivity — the first request after hibernation is slow (cold start ~30s). KV free tier is 100k reads/day, which is fine until you get real traffic. Worker free tier is 100k requests/day — static prerendered pages served by Pages do **not** count against this, only API calls do.


