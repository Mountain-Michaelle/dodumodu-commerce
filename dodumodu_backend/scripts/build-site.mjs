// scripts/build-site.mjs — zero dependencies, Node 18+
// Reads the built storefront from dodumodu_site/dist/, inlines the CSS into
// the root HTML, extracts the content-hashed JS URL, computes strict CSP hashes
// for the remaining inline blocks, fetches the latest published snapshot for
// every product from the database, renders each product page, and writes
// src/generated/site.ts with INDEX_HTML (flagship /), PRODUCTS map, BUILD_ID,
// APP_JS, and CSP.
//
// No database read happens at request time: every product page is pre-rendered
// at build time and served from memory.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import * as schema from '../src/schema'
import { renderProduct } from '../build/render-product.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(__dirname, '..')
const repoRoot = resolve(backendRoot, '..')
const rootEnvPath = join(repoRoot, '.env')
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath)

const IN = process.env.WEB_DIR ?? join(__dirname, '..', '..', 'dodumodu_site', 'dist')
const OUT = process.env.OUT ?? join(__dirname, '..', 'src', 'generated', 'site.ts')
const read = (f) => readFileSync(join(IN, f), 'utf8')
const sha = (s, enc) => createHash('sha256').update(s).digest(enc)
const etag = (s) => `"${sha(s, 'hex').slice(0, 16)}"`
const lit = (k, v) => `export const ${k} = ${JSON.stringify(v)}\n`

// A build id derived from the current time plus random bytes so each deploy
// is distinguishable even when two builds start in the same millisecond.
// Stored in site_builds and revalidated before deploy (safeguard 1).
const BUILD_ID = `build_${Date.now()}_${randomBytes(4).toString('hex')}`

// ---------------------------------------------------------------------------
// Facts the published pages must reproduce EXACTLY, taken from the built page
// (dist/products/glow-serum/index.html) that the CSP hashes are computed from.
// Taking them from that one place means a published page can never carry a
// different logo sprite, a different inline script, or different runtime
// config than the page the CSP was written for.
// ---------------------------------------------------------------------------
export function extractPageParts(html) {
  const runtimeConfig = html.match(/<script>window\.API_BASE=[^<]*<\/script>/)?.[0]
  const sprite = html.match(/<svg class="dm-defs"[\s\S]*?(?=<a href="#order-form" class="skip-link">)/)?.[0]
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/ld\+json/.test(m[1]) && !/window\.API_BASE=/.test(m[2]))
    .map((m) => m[0])
  if (!runtimeConfig) throw new Error('built page has no runtime config script (window.API_BASE)')
  if (!sprite) throw new Error('built page has no logo/icon sprite before the skip link')
  if (scripts.length === 0) throw new Error('built page has no inline scripts to carry into published pages')
  const cfg = (name) => {
    const m = runtimeConfig.match(new RegExp(`window\\.${name}=("(?:[^"\\\\]|\\\\.)*")`))
    return m ? JSON.parse(m[1]) : ''
  }
  return {
    runtimeConfig,
    sprite,
    inlineScripts: scripts.join(''),
    turnstileSiteKey: html.match(/data-sitekey="([^"]*)"/)?.[1] ?? '',
    apiBase: cfg('API_BASE'),
    imageDeliveryBase: cfg('IMAGE_DELIVERY_BASE'),
  }
}

const CF_CHALLENGES = 'https://challenges.cloudflare.com'
const originOf = (url) => { try { return new URL(url).origin } catch { return null } }

// The page CSP. Everything beyond 'self' is something the page really loads:
// the image host (a CSP of img-src 'self' blocks the hero when media lives on
// its own R2 domain), the API host when it is not same-origin, and Turnstile's
// script + iframe when a site key is configured (without them no order can be
// placed, because the server refuses an order that carries no token).
export function buildCsp({ scriptHashes, styleHashes, imgOrigins = [], connectOrigins = [], turnstile = false }) {
  return [
    `default-src 'none'`,
    `script-src 'self' ${scriptHashes.join(' ')}${turnstile ? ` ${CF_CHALLENGES}` : ''}`,
    `style-src ${styleHashes.join(' ')}`,
    `img-src ${["'self'", 'data:', ...imgOrigins].join(' ')}`,
    `connect-src ${["'self'", ...connectOrigins].join(' ')}`,
    ...(turnstile ? [`frame-src ${CF_CHALLENGES}`] : []),
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ')
}

// ---------------------------------------------------------------------------
// Empty-catalog storefront root page.
// Used when no published products exist: the build must still emit a valid
// INDEX_HTML so the Worker can serve /, without fabricating any product data.
// No snapshot is rendered here — PRODUCTS stays {} and the page simply states
// that no products are published yet.
// ---------------------------------------------------------------------------
export function renderEmptyCatalog({ css, jsPath, csp, buildId }) {
  const jsFile = jsPath.replace(/^\//, '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Storefront — DODUMODU</title>
<meta name="description" content="No products published yet.">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#fff8f5">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3C/svg%3E">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${css}</style>
</head>
<body>
<main>
<h1>Storefront</h1>
<p>No products are published yet.</p>
</main>
<script src="${jsFile}" defer></script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// 1) Read the base storefront page (glow-serum) for CSS + JS extraction.
//    Every product page shares the same CSS and JS bundle.
// ---------------------------------------------------------------------------
async function main() {
  let baseHtml = read('products/glow-serum/index.html')

// 1a) inline the CSS
const LINK = /<link[^>]*rel="stylesheet"[^>]*href="([^"]+\.css)">/
const linkMatch = baseHtml.match(LINK)
if (!linkMatch) throw new Error('index.html must contain <link rel="stylesheet" href="...">')
const cssFile = linkMatch[1]
const css = read(cssFile)
baseHtml = baseHtml.replace(LINK, () => `<style>${css}</style>`)

// 1b) extract content-hashed JS
const SCRIPT = /<script[^>]*src="([^"]+\.js)"[^>]*><\/script>/
const jsMatch = baseHtml.match(SCRIPT)
if (!jsMatch) throw new Error('index.html must contain <script src="..." defer></script>')
const jsPath = jsMatch[1]
const js = read(jsMatch[1])

// 1c) strict CSP validation + hashes
const bad = baseHtml.match(/\sstyle="|\son[a-z]+="/)
if (bad) throw new Error(`index.html still has an inline style/handler attribute: ${bad[0]}`)
const inline = (tag) =>
  [...baseHtml.matchAll(new RegExp(`<${tag}(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))]
    .map((m) => `'sha256-${sha(m[1], 'base64')}'`)
const parts = extractPageParts(baseHtml)
const scriptHashes = inline('script')
const styleHashes = inline('style')

// ---------------------------------------------------------------------------
// 2) Fetch the latest published snapshot for every product from the database.
// ---------------------------------------------------------------------------
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for build-site.mjs — set it before running')
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 })
const db = drizzle(pool, { schema })

let products = []
try {
  const { productPublishes, products: productsTable } = schema
  // Every product with its newest publish (by id, which cannot tie)
  const all = await db
    .select({
      productId: productsTable.id,
      slug: productsTable.slug,
      name: productsTable.name,
      description: productsTable.description,
      price: productsTable.price,
      publishId: productPublishes.id,
      payload: productPublishes.payload,
      buildStatus: productPublishes.buildStatus,
      publishProductId: productPublishes.productId,
    })
    .from(productsTable)
    .leftJoin(productPublishes, eq(productPublishes.productId, productsTable.id))

  // Reduce to the newest publish per product (highest id wins)
  const latestByProduct = new Map()
  for (const row of all) {
    const pid = row.productId
    const existing = latestByProduct.get(pid)
    if (!existing || (row.publishId && row.publishId > existing.publishId)) {
      latestByProduct.set(pid, {
        id: row.productId,
        slug: row.slug,
        name: row.name,
        description: row.description,
        price: row.price,
        publishId: row.publishId,
        snapshot: row.payload,
        buildStatus: row.buildStatus,
      })
    }
  }
  products = [...latestByProduct.values()].filter((p) => p.publishId != null)
} finally {
  await pool.end()
}

// ---------------------------------------------------------------------------
// 2b) Deployment facts. In CI these come from the workflow environment; a build that
//     silently fell back to the placeholder origin would publish canonical URLs and
//     link previews that point at yoursite.com, so CI refuses to build without them.
// ---------------------------------------------------------------------------
const siteUrl = (process.env.SITE_URL ?? '').trim().replace(/\/+$/, '')
if (process.env.GITHUB_ACTIONS === 'true' && (!/^https:\/\//.test(siteUrl) || /yoursite\.com/.test(siteUrl))) {
  throw new Error('SITE_URL must be the real https:// origin of the storefront in CI (set the SITE_URL secret); refusing to publish placeholder canonical and og:url values')
}

// Absolute image URLs (demo data, or a row pointing at a CDN asset) need their origin in img-src too.
const imgOrigins = new Set()
const deliveryOrigin = originOf(parts.imageDeliveryBase)
if (deliveryOrigin) imgOrigins.add(deliveryOrigin)
for (const row of products) {
  for (const img of [...(row.snapshot?.images ?? []), ...(row.snapshot?.testimonials ?? [])]) {
    if (/^https?:\/\//i.test(img?.r2Key ?? '')) { const o = originOf(img.r2Key); if (o) imgOrigins.add(o) }
  }
}
const apiOrigin = originOf(parts.apiBase)
const CSP = buildCsp({
  scriptHashes,
  styleHashes,
  imgOrigins: [...imgOrigins],
  connectOrigins: apiOrigin ? [apiOrigin] : [],
  turnstile: parts.turnstileSiteKey !== '',
})

// ---------------------------------------------------------------------------
// 2a) Record the build as triggered in site_builds before rendering.
//    This must happen before any render/deploy step so that a failure
//    can be associated with a build record. Uses the Worker's own
//    authenticated /admin/deploy-trigger endpoint.
// ---------------------------------------------------------------------------
async function recordBuildTriggered(buildId, intendedPublications) {
  const workerUrl = (process.env.WORKER_URL ?? "").replace(/\/+$/, "")
  const secret = (process.env.DEPLOY_TRIGGER_SECRET ?? "").trim()
  if (!workerUrl || !secret) {
    console.log("build-site: WORKER_URL or DEPLOY_TRIGGER_SECRET not set — skipping build record (first deploy or local build)")
    return
  }
  const body = JSON.stringify({ buildId, intendedPublications })
  try {
    const res = await fetch(`${workerUrl}/admin/deploy-trigger`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.warn(`build-site: deploy-trigger returned HTTP ${res.status}: ${text}`)
      return
    }
    const result = await res.json().catch(() => null)
    console.log(`build-site: build recorded as triggered — buildId=${buildId} publications=${intendedPublications.length}`, result ?? "")
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`build-site: deploy-trigger call failed: ${reason}`)
  }
}

const intendedPublications = products
  .filter((p) => p.publishId != null)
  .map((p) => ({ slug: p.slug, publishId: p.publishId }))

await recordBuildTriggered(BUILD_ID, intendedPublications)

// ---------------------------------------------------------------------------
// 3) Render every product page from its snapshot.
//    The flagship / is glow-serum.
// ---------------------------------------------------------------------------
const flagshipSlug = 'glow-serum'
const PRODUCTS = {}
let flagshipHtml = null

for (const row of products) {
  const { slug, snapshot, publishId } = row
  if (!slug || !snapshot) continue

  // The payload does not carry its own publish id (it is the row's id); the page's
  // storefront-publish-id marker is what verify-deploy.mjs and the admin LIVE check compare.
  const html = renderProduct({ ...snapshot, publishId }, {
    css,
    jsPath,
    csp: CSP,
    buildId: BUILD_ID,
    maxOrderQuantity: process.env.MAX_ORDER_QUANTITY ?? '20',
    siteUrl,
    deliveryBase: parts.imageDeliveryBase,
    sprite: parts.sprite,
    runtimeConfig: parts.runtimeConfig,
    inlineScripts: parts.inlineScripts,
    turnstileSiteKey: parts.turnstileSiteKey,
  })

  PRODUCTS[slug] = {
    html,
    publishId,
    etag: etag(html),
  }

  if (slug === flagshipSlug) flagshipHtml = html
}

if (!flagshipHtml) {
  if (products.length > 0) {
    throw new Error('no products could be rendered — flagship page is missing')
  }
  // Empty catalog: render a valid root page instead of failing the build.
  // No product data is fabricated; PRODUCTS stays {}.
  flagshipHtml = renderEmptyCatalog({ css, jsPath, csp: CSP, buildId: BUILD_ID })
}

// ---------------------------------------------------------------------------
// 4) Write src/generated/site.ts
// ---------------------------------------------------------------------------
mkdirSync(dirname(OUT), { recursive: true })
const out =
  `// GENERATED by scripts/build-site.mjs, do not edit\n` +
  lit('BUILD_ID', BUILD_ID) +
  lit('INDEX_HTML', flagshipHtml) +
  lit('INDEX_ETAG', etag(flagshipHtml)) +
  lit('PRODUCTS', JSON.stringify(PRODUCTS)) +
  lit('THANK_YOU_HTML', read('thank-you.html')) +
  lit('APP_JS', js) +
  lit('APP_JS_PATH', jsPath) +
  lit('APP_JS_ETAG', etag(js)) +
  lit('CSP', CSP)

writeFileSync(OUT, out)

// Hand the build id and the intended publications to the workflow. The workflow used to scrape these
// out of the generated file with a regex that could not match (PRODUCTS is a JSON *string* literal),
// which left EXPECTED empty and made verify-deploy refuse every build.
if (process.env.GITHUB_OUTPUT) {
  const expected = Object.fromEntries(Object.entries(PRODUCTS).map(([slug, p]) => [slug, p.publishId]))
  appendFileSync(process.env.GITHUB_OUTPUT, `build_id=${BUILD_ID}\nexpected=${JSON.stringify(expected)}\n`)
}

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB'
console.log(
  `built ${OUT}\n` +
    `  BUILD_ID ${BUILD_ID}\n` +
    `  products rendered: ${Object.keys(PRODUCTS).length} (${Object.keys(PRODUCTS).join(', ')})\n` +
    `  index.html ${kb(flagshipHtml)}  ${jsPath} ${kb(js)}\n` +
    `  CSP hashes: ${scriptHashes.length} script, ${styleHashes.length} style | img origins: ${[...imgOrigins].join(', ') || 'self'}${parts.turnstileSiteKey ? ' | turnstile allowed' : ''}`
  )
}

// Run the build only when this file is executed directly (e.g.
// `tsx scripts/build-site.mjs`), not when imported (e.g. in tests that only
// need renderEmptyCatalog). When imported, main() is intentionally skipped so
// that DATABASE_URL is not required just to import a pure function.
const _entryFile = process.argv[1]?.replace(/\\/g, "/") ?? ""
if (_entryFile && import.meta.url.endsWith(_entryFile)) {
  main()
}
