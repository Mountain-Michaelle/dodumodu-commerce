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
const BUILD_ID = (process.env.BUILD_ID ?? '').trim() || `build_${Date.now()}_${randomBytes(4).toString('hex')}`

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
// Product images are served from the media origin (IMAGE_DELIVERY_BASE), so the page's CSP must allow it or the
// browser silently refuses every image. Read from the environment, else from wrangler.toml's [vars].
function mediaOrigin() {
  let v = process.env.IMAGE_DELIVERY_BASE
  if (!v) {
    try { v = /^\s*IMAGE_DELIVERY_BASE\s*=\s*"([^"]*)"/m.exec(readFileSync(join(backendRoot, 'wrangler.toml'), 'utf8'))?.[1] } catch { /* none */ }
  }
  try { const u = new URL(v ?? ''); return u.protocol === 'https:' ? u.origin : '' } catch { return '' }
}
const inline = (tag) =>
  [...baseHtml.matchAll(new RegExp(`<${tag}(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))]
    .map((m) => `'sha256-${sha(m[1], 'base64')}'`)
const CSP = [
  `default-src 'none'`,
  `script-src 'self' ${inline('script').join(' ')}`,
  `style-src ${inline('style').join(' ')}`,
  `img-src 'self' data:${mediaOrigin() ? ' ' + mediaOrigin() : ''}`,
  `connect-src 'self'`,
  `base-uri 'none'`,
  `form-action 'self'`,
  `frame-ancestors 'none'`,
].join('; ')

// ---------------------------------------------------------------------------
// 2) Fetch the latest published snapshot of every product from the Worker.
//
// The build holds NO database credential. The Worker (which already owns the database) serves the
// snapshots at GET /ci/snapshots, guarded by DEPLOY_TRIGGER_SECRET, so a leaked CI secret can read
// published page content and nothing else - it cannot open a connection to the database.
// ---------------------------------------------------------------------------
const workerUrl = (process.env.WORKER_URL ?? '').replace(/\/+$/, '')
const ciSecret = (process.env.DEPLOY_TRIGGER_SECRET ?? '').trim()
if (!workerUrl || !ciSecret) {
  throw new Error('WORKER_URL and DEPLOY_TRIGGER_SECRET are required: the build fetches snapshots from the Worker (/ci/snapshots)')
}

async function ci(path, init = {}) {
  const res = await fetch(`${workerUrl}/ci${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${ciSecret}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`Worker ${init.method ?? 'GET'} /ci${path} returned HTTP ${res.status}${text ? `: ${text}` : ''}`)
  }
  return res.json()
}

const { snapshots } = await ci('/snapshots')
const REF = /^pub_[0-9a-f]{20}$/
const products = snapshots
  .filter((r) => r.payload)
  .map((r) => {
    if (!REF.test(r.publishRef ?? '')) throw new Error(`snapshot for ${r.slug} has no valid publish ref (${r.publishRef})`)
    return { id: r.productId, slug: r.slug, name: r.name, description: r.description, price: r.price,
      publishId: r.publishId, publishRef: r.publishRef, snapshot: r.payload }
  })

// Record what this build intends to ship, BEFORE rendering, so a failure from here on is attached to a
// build the admin can see. The id comes from the run that was dispatched (BUILD_ID) when there is one.
const intendedPublications = products.map((p) => ({ slug: p.slug, publishId: p.publishId, publishRef: p.publishRef }))
await ci(`/builds/${encodeURIComponent(BUILD_ID)}/start`, {
  method: 'POST',
  body: JSON.stringify({
    intendedPublications,
    ...(process.env.RUN_URL ? { runUrl: process.env.RUN_URL } : {}),
  }),
})
console.log(`build-site: build ${BUILD_ID} recorded with ${intendedPublications.length} publication(s)`)

// ---------------------------------------------------------------------------
// 3) Render every product page from its snapshot.
//    The flagship / is glow-serum.
// ---------------------------------------------------------------------------
const flagshipSlug = 'glow-serum'
const PRODUCTS = {}
let flagshipHtml = null

for (const row of products) {
  const { slug, snapshot, publishId, publishRef } = row
  if (!slug || !snapshot) continue

  const html = renderProduct({ ...snapshot, publishRef }, {
    css,
    jsPath,
    csp: CSP,
    buildId: BUILD_ID,
    maxOrderQuantity: process.env.MAX_ORDER_QUANTITY ?? '20',
  })

  PRODUCTS[slug] = {
    html,
    publishId,
    publishRef,
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
// What the verifier must find on the live pages once this build is deployed.
writeFileSync(
  join(dirname(OUT), 'build-meta.json'),
  JSON.stringify({ buildId: BUILD_ID, expected: Object.fromEntries(products.filter((p) => PRODUCTS[p.slug]).map((p) => [p.slug, p.publishRef])) }, null, 2),
)

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
