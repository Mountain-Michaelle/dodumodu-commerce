// scripts/verify-deploy.mjs — post-deploy marker verification (CI).
// Fetches the public storefront root and every intended product slug and reads
// the <meta name="storefront-publish-id"> + <meta name="storefront-build-id">
// markers. On ANY mismatch, stale response, timeout, or fetch failure the build
// is left unverified (exit 1) — a successful `wrangler deploy` alone NEVER
// marks a publication LIVE. Retry: re-run the workflow; the stale build is
// refused if a newer intended set has since been published.
//
// Env:
//   SITE_URL               public storefront origin, e.g. https://yoursite.com
//   EXPECTED               JSON map { slug: publishId } of the intended set
//   EXPECTED_BUILD_ID      build id the markers must carry (optional but recommended)
import { Pool } from 'pg'

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/+$/, '')
const EXPECTED_BUILD_ID = (process.env.EXPECTED_BUILD_ID ?? '').trim()
const WORKER_URL = (process.env.WORKER_URL ?? '').replace(/\/+$/, '')
const DEPLOY_TRIGGER_SECRET = (process.env.DEPLOY_TRIGGER_SECRET ?? '').trim()
let EXPECTED = {}
try {
  EXPECTED = JSON.parse(process.env.EXPECTED ?? '{}')
} catch (err) {
  console.error(`verify-deploy: EXPECTED is not valid JSON: ${err.message}`)
  process.exit(2)
}

if (!SITE_URL) {
  console.error('verify-deploy: SITE_URL is required (public storefront origin)')
  process.exit(2)
}

const slugs = Object.keys(EXPECTED)
if (slugs.length === 0) {
  console.error('verify-deploy: EXPECTED is empty — refusing to verify a build with no intended publications')
  process.exit(2)
}

const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 8000)

function readMarker(html, name) {
  const direct = new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']\\s*\\/?>`, 'i')
  const reversed = new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+name=["']${name}["']\\s*\\/?>`, 'i')
  return direct.exec(html)?.[1] ?? reversed.exec(html)?.[1] ?? null
}

async function fetchPage(slug) {
  const url = `${SITE_URL}/${slug}/`
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'dodumodu-deploy-verifier', 'Cache-Control': 'no-cache' },
  })
  if (!res.ok) return { ok: false, status: res.status, html: null, url }
  return { ok: true, status: res.status, html: await res.text(), url }
}

// Bounded callback to the Worker's build-status endpoints. A callback failure
// is logged and returned as false — it never overrides the verification result
// that the caller is acting on.
async function postLifecycle(endpoint, buildId, body = {}) {
  if (!WORKER_URL || !DEPLOY_TRIGGER_SECRET || !buildId) {
    console.log(`verify-deploy: skipping ${endpoint} callback — WORKER_URL, DEPLOY_TRIGGER_SECRET, or buildId not configured`)
    return false
  }
  const url = `${WORKER_URL}/admin/builds/${encodeURIComponent(buildId)}/${endpoint}`
  let attempts = 0
  const maxAttempts = 3
  while (attempts < maxAttempts) {
    attempts += 1
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${DEPLOY_TRIGGER_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        console.log(`verify-deploy: ${endpoint} callback accepted for build ${buildId}`)
        return true
      }
      const text = await res.text().catch(() => '')
      console.warn(`verify-deploy: ${endpoint} callback returned HTTP ${res.status}: ${text}`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`verify-deploy: ${endpoint} callback attempt ${attempts}/${maxAttempts} failed: ${reason}`)
    }
    if (attempts < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * attempts))
  }
  console.error(`verify-deploy: ${endpoint} callback failed after ${maxAttempts} attempts — build status may be stale`)
  return false
}

// Re-read the newest publishes and refuse if anything changed while the build
// was running (safeguard 1: publication consistency).
async function revalidateIntent() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    // No DB handle in this step: the verifier still checks markers, it just
    // cannot prove staleness from here. CI passes DATABASE_URL for the full check.
    console.log('verify-deploy: no DATABASE_URL — skipping staleness revalidation')
    return { stale: false }
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const { rows } = await pool.query(
      `SELECT p.slug, pp.id AS publish_id
         FROM products p
         JOIN product_publishes pp ON pp.product_id = p.id
        WHERE pp.id = (SELECT MAX(pp2.id) FROM product_publishes pp2 WHERE pp2.product_id = p.id)`,
    )
    const current = Object.fromEntries(rows.map((r) => [r.slug, r.publish_id]))
    for (const [slug, publishId] of Object.entries(EXPECTED)) {
      if (current[slug] !== publishId) {
        return { stale: true, detail: `/${slug}/ now publishes ${current[slug] ?? 'nothing'}, expected ${publishId}` }
      }
    }
    // A newly published slug the build never rendered is also stale.
    for (const slug of Object.keys(current)) {
      if (!(slug in EXPECTED)) {
        return { stale: true, detail: `/${slug}/ has a publish the build did not render` }
      }
    }
    return { stale: false }
  } finally {
    await pool.end()
  }
}

// The build ID reported back to the Worker. ExpectEXPECTED_BUILD_ID is set by
// CI from the rendered output; if absent we cannot report a build ID.
const BUILD_ID = EXPECTED_BUILD_ID || null

const failures = []

const intent = await revalidateIntent()
if (intent.stale) {
  console.error(`verify-deploy: STALE — ${intent.detail}. Refusing to mark this build verified.`)
  if (BUILD_ID) await postLifecycle('mark-failed', BUILD_ID, { error: `stale: ${intent.detail}` })
  process.exit(1)
}

for (const [slug, publishId] of Object.entries(EXPECTED)) {
  const expectedVersion = `pub_${publishId}`
  let page
  try {
    page = await fetchPage(slug)
  } catch (err) {
    failures.push(`/${slug}/: fetch failed (${err.name ?? err})`)
    continue
  }
  if (!page.ok) {
    failures.push(`/${slug}/: HTTP ${page.status}`)
    continue
  }
  const liveVersion = readMarker(page.html, 'storefront-publish-id')
  const liveBuild = readMarker(page.html, 'storefront-build-id')
  if (liveVersion !== expectedVersion) {
    failures.push(`/${slug}/: live ${liveVersion ?? '(no marker)'} != expected ${expectedVersion}`)
    continue
  }
  if (EXPECTED_BUILD_ID && liveBuild !== EXPECTED_BUILD_ID) {
    failures.push(`/${slug}/: build ${liveBuild ?? '(no marker)'} != expected ${EXPECTED_BUILD_ID}`)
  }
}

if (failures.length > 0) {
  console.error('verify-deploy: FAILED')
  for (const f of failures) console.error(`  - ${f}`)
  console.error('Leaving publications PUBLISHED/pending — retry with `gh workflow run deploy-storefront.yml`.')
  if (BUILD_ID) await postLifecycle('mark-failed', BUILD_ID, { error: failures.join('; ') })
  process.exit(1)
}

console.log(`verify-deploy: OK — ${slugs.length} product page(s) verified against their intended publishes.`)

if (BUILD_ID) {
  await postLifecycle('mark-verified', BUILD_ID)
}
