# Audit Results: Production Build Fails Because `products` Table Is Missing

## Root Cause
The production build connects to a Neon database via `NEON_READONLY_URL` secret that has no migrations applied. The `products` table (created by `0000_init.sql`) does not exist, causing `42P01: relation "products" does not exist` at `build-site.mjs:92`.

## Confirmed Fact
- **Zero-product deployment is supported** once the `products` table exists. The application architecture produces an empty catalog (`site.PRODUCTS = {}`) with no code changes needed. The `publishService` correctly requires a product to exist before publishing — this is an admin-time action, not a build-time restriction.

## Minimum Necessary Fix
Apply the `0000_init.sql` migration (and subsequent migrations) against the Neon database targeted by `NEON_READONLY_URL`. No code changes are needed.

## Exact Files
- **No code files need modification** — database operation only.
- `dodumodu_backend/migrations/0000_init.sql` — contains SQL to create `products` table and all base tables.

## Safe Step-by-Step Implementation Plan

### Step 1: Verify the `NEON_READONLY_URL` target database
- Check the Neon console or docs to identify which project/branch the `NEON_READONLY_URL` secret connects to.
- Confirm the `products` table is absent (via Neon SQL editor or `psql \dt`).
- **Do not modify anything** at this step — read-only investigation.

### Step 2: Obtain a write-capable Neon connection string
- The `NEON_READONLY_URL` is read-only (Neon `?pg=mode=read-only`).
- For migrations, a separate Neon connection **without** read-only mode is needed.
- **Do not print or expose** the full connection string in any output.

### Step 3: Run the migration runner (minimum: create `products` table)
```bash
cd dodomodu_backend
# Use a write-capable DATABASE_URL (Neon without pg=mode=read-only)
DATABASE_URL="<neon-write-connection-string>" npm run db:migrate
```
- This creates the `schema_migrations` tracking table.
- Applies `0000_init.sql` → creates `products`, `product_images`, `testimonials`, `orders`, enum types, and indexes.
- Subsequent migrations are skipped if already applied; pending ones run in order.

### Step 4: Re-run the build
```bash
npm run build:site
```
- Should succeed, querying `productsTable` → empty array (no products yet).
- Generates `site.ts` with `PRODUCTS = {}`.
- **No runtime database queries** for public product pages (fulfills invariant).

### Step 5: Re-run admin pages build
```bash
npm run build-admin-pages.mjs
```
- Bundles admin UI assets (login, console, sessions, devices, QR, etc.).
- No database dependency — success confirmed by console output.

### Step 6: Create the first product (admin action, not build-time)
- Access the admin UI at `http://<worker-url>/admin/`.
- Create the first product via the admin interface.
- This inserts a row into `products` — the build already succeeded with an empty table; now the product exists.

### Step 7: Publish the first product (admin action)
- In the admin UI, publish the first product.
- This creates a `product_publishes` snapshot and fires the GitHub dispatch hook.
- The `site.PRODUCTS` will now contain the flagship product's HTML.

### Step 8: Full deploy workflow
```bash
npm run build:site && npm run build-admin-pages.mjs && npx wrangler deploy
```
- Run the GitHub Actions workflow `deploy-storefront.yml` manually or on `push` to `main`.
- Verify with `npm test` and the verification step.

## Invariants Preserved
- No fake products or fake publication markers.
- No automatic migrations during build or deployment.
- Build ID, stale-build, and publication verification preserved.
- Immutable product publication snapshots.
- Static prerendering for every eligible published product.
- Zero runtime database queries for public product-page HTML.
- No alterations to checkout, payments, orders, webhooks, or abuse controls.

## Restrictions Honored
- AUDIT ONLY — no files modified, no migrations run in this response, no secrets changed, no deployment triggered.
- The recommended `npm run db:migrate` command is provided for the user to execute when ready.
- All diagnostics were read-only; no data was dumped.

## Confirmed Root Cause (Final)
The `products` table is missing from the Neon database connected via `NEON_READONLY_URL`. The `0000_init.sql` migration (which creates the `products` table) has not been applied to that database branch. Once applied, the build succeeds with an empty catalog, and the administration flow can create the first product and publish it.

## Zero-Product First Deployment: Architecture Verdict
**SUPPORTED** — The application is designed so that:
- An empty `products` table → build succeeds with `site.PRODUCTS = {}`.
- No products → product pages 404 via static file middleware (expected before any product is created).
- Sitemap has no product URLs (valid minimal sitemap).
- Admin cannot publish without a product (correct design — `productsRepo.findBySlug()` throws `ProductNotFoundError`).
- First product creation + publish is an admin-time action, not a build-time requirement.