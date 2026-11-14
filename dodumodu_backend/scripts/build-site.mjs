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
// 2) Fetch the latest published snapshot of every product from the Worker.
//
// The build holds NO database credential. The Worker (which already owns the database) serves the
// snapshots at GET /ci/snapshots, guarded by DEPLOY_TRIGGER_SECRET, so a leaked CI secret can read
// published page content and nothing else - it cannot open a connection to the database.
// ---------------------------------------------------------------------------
const workerUrl = (process.env.WORKER_URL ?? '').replace(/\/+$/, '')
const ciSecret = (process.env.DEPLOY_TRIGGER_SECRET ?? '').trim()

async function ci(path, init = {}) {
  const res = await fetch(`${workerUrl}/ci${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${ciSecret}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    const err = new Error(`Worker ${init.method ?? 'GET'} /ci${path} returned HTTP ${res.status}${text ? `: ${text}` : ''}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

// Two separate jobs, deliberately not one:
//
//   APPLICATION BUILD  (npm run build:site, and every Cloudflare/git build)
//       Builds the app. Publishes nothing, fetches nothing, needs no credentials: it renders the empty catalog
//       and always succeeds on its own merits. Products are not its business.
//   PUBLISH BUILD      (npm run build:site:snapshots, run only by the deploy-storefront workflow)
//       Renders every published product from the snapshots the Worker serves. It is strict: missing credentials or
//       an unreachable Worker FAIL it, because a publish that silently rendered nothing would be worse than none.
//
// A failed publish build deploys nothing, so the storefront that is live keeps serving.
const wantSnapshots = process.argv.includes('--snapshots')
let snapshots = []
let bootstrap = null
if (!wantSnapshots) {
  bootstrap = 'this is the application build, which does not publish products'
} else {
  if (!workerUrl || !ciSecret) {
    throw new Error('the publish build needs WORKER_URL and DEPLOY_TRIGGER_SECRET (GitHub Actions secrets) to fetch the published snapshots from the Worker')
  }
  snapshots = (await ci('/snapshots')).snapshots
}
if (bootstrap) {
  console.warn(
    `\nbuild-site: ${bootstrap}. Rendering the empty catalog; no credentials are used.\n` +
    '  Products are published only from the admin (Publish), which runs the publish build.\n',
  )
}

const REF = /^pub_[0-9a-f]{20}$/
const products = snapshots
  .filter((r) => r.payload)
  .map((r) => {
    if (!REF.test(r.publishRef ?? '')) throw new Error(`snapshot for ${r.slug} has no valid publish ref (${r.publishRef})`)
    return { id: r.productId, slug: r.slug, name: r.name, description: r.description, price: r.price,
      publishId: r.publishId, publishRef: r.publishRef, snapshot: r.payload }
  })

// A run the Worker dispatched (BUILD_ID given) reports what it will build BEFORE rendering, so a failure from here
// on is attached to a build the admin can see. A build nobody queued has no row to report to and records nothing:
// the admin still sees it go LIVE, because that is decided by the page's own publish marker.
const intendedPublications = products.map((p) => ({ slug: p.slug, publishId: p.publishId, publishRef: p.publishRef }))
if (process.env.BUILD_ID && !bootstrap) {
  await ci(`/builds/${encodeURIComponent(BUILD_ID)}/start`, {
    method: 'POST',
    body: JSON.stringify({
      intendedPublications,
      ...(process.env.RUN_URL ? { runUrl: process.env.RUN_URL } : {}),
    }),
  })
  console.log(`build-site: build ${BUILD_ID} recorded with ${intendedPublications.length} publication(s)`)
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
  lit('THANK_YOU_HTML', read('thank-you.html')) +
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
