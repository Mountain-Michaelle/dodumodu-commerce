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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
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
const CSP = [
  `default-src 'none'`,
  `script-src 'self' ${inline('script').join(' ')}`,
  `style-src ${inline('style').join(' ')}`,
  `img-src 'self' data:`,
  `connect-src 'self'`,
  `base-uri 'none'`,
  `form-action 'self'`,
  `frame-ancestors 'none'`,
].join('; ')

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
} catch (err) {
  // A permission error here is a setup problem, not a code bug. Say exactly which
  // role connected and which database it reached so the grant can be written for it.
  const code = err?.cause?.code ?? err?.code
  if (code === '42501' || code === '42P01') {
    const who = await pool.query('select current_user as u, current_database() as d').catch(() => null)
    const row = who?.rows?.[0]
    console.error(
      `\nBUILD SETUP ERROR (${code}): the role in NEON_READONLY_URL cannot read the tables the build needs.\n` +
      `  connected as: ${row?.u ?? 'unknown'}   database: ${row?.d ?? 'unknown'}\n` +
      `  fix (run as the database owner, in THAT database):\n` +
      `    GRANT USAGE ON SCHEMA public TO "${row?.u ?? '<role>'}";\n` +
      `    GRANT SELECT ON products, product_publishes TO "${row?.u ?? '<role>'}";\n`)
  }
  throw err
} finally {
  await pool.end()
}

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

  const html = renderProduct(snapshot, {
    css,
    jsPath,
    csp: CSP,
    buildId: BUILD_ID,
    maxOrderQuantity: process.env.MAX_ORDER_QUANTITY ?? '20',
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
  lit('APP_JS', js) +
  lit('APP_JS_PATH', jsPath) +
  lit('APP_JS_ETAG', etag(js)) +
  lit('CSP', CSP)

writeFileSync(OUT, out)

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB'
console.log(
  `built ${OUT}\n` +
    `  BUILD_ID ${BUILD_ID}\n` +
    `  products rendered: ${Object.keys(PRODUCTS).length} (${Object.keys(PRODUCTS).join(', ')})\n` +
    `  index.html ${kb(flagshipHtml)}  ${jsPath} ${kb(js)}\n` +
    `  CSP hashes: ${inline('script').length} script, ${inline('style').length} style`
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
