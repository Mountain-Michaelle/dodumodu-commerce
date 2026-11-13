// scripts/verify-deploy.mjs - post-deploy verification (CI).
//
// Reads the PUBLIC storefront - the same bytes a customer gets - and checks every product page carries the publish
// ref and build id this build rendered. `wrangler deploy` succeeding proves nothing about what is served, so a
// publication is only ever reported LIVE after this has seen it. Then it asks the Worker to read the pages itself
// and record the result: the Worker's own reading, not this script's word, is what marks the build verified.
//
// It also refuses to verify a build that has been overtaken: if a product was published again while this build
// ran, the newer publish belongs to a newer build.
//
// Env: SITE_URL, WORKER_URL, DEPLOY_TRIGGER_SECRET, BUILD_ID.   Optional: VERIFY_ATTEMPTS (8), VERIFY_DELAY_MS (6000).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { post, redact } from './ci.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/+$/, '')
const WORKER_URL = (process.env.WORKER_URL ?? '').replace(/\/+$/, '')
const SECRET = (process.env.DEPLOY_TRIGGER_SECRET ?? '').trim()
const ATTEMPTS = Number(process.env.VERIFY_ATTEMPTS ?? 8)
const DELAY_MS = Number(process.env.VERIFY_DELAY_MS ?? 6000)
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 8000)

const STEP = 'verify'
const LABEL = 'Reading the live storefront'

async function fail(message) {
  console.error(`verify-deploy: ${message}`)
  const r = await post('events', { step: STEP, label: LABEL, status: 'failed', message: redact(message).slice(0, 3500) })
  if (!r.ok) console.warn(`verify-deploy: could not report the failure (${r.status}): ${r.text}`)
  process.exit(1)
}

if (!SITE_URL) await fail('SITE_URL is not set. Add it as a GitHub Actions secret (the public storefront origin).')

let meta
try {
  meta = JSON.parse(readFileSync(join(here, '..', 'src', 'generated', 'build-meta.json'), 'utf8'))
} catch (err) {
  await fail(`cannot read the build metadata: ${err.message}`)
}
const expected = meta.expected ?? {}
const buildId = meta.buildId
const slugs = Object.keys(expected)
if (slugs.length === 0) {
  console.log('verify-deploy: no products are published, so there is nothing to look for - asking the Worker to close the build.')
}
await post('events', { step: STEP, label: LABEL, status: 'running' })

function readMarker(html, name) {
  const direct = new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']\\s*\\/?>`, 'i')
  const reversed = new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+name=["']${name}["']\\s*\\/?>`, 'i')
  return direct.exec(html)?.[1] ?? reversed.exec(html)?.[1] ?? null
}

async function problems() {
  const found = []
  for (const slug of slugs) {
    try {
      const res = await fetch(`${SITE_URL}/${slug}/`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'dodumodu-deploy-verifier', 'Cache-Control': 'no-cache' },
      })
      if (!res.ok) { found.push(`/${slug}/ answered HTTP ${res.status}`); continue }
      const html = await res.text()
      const ref = readMarker(html, 'storefront-publish-id')
      const build = readMarker(html, 'storefront-build-id')
      if (ref !== expected[slug]) found.push(`/${slug}/ serves ${ref ?? '(no marker)'}, expected ${expected[slug]}`)
      else if (build !== buildId) found.push(`/${slug}/ is from build ${build ?? '(no marker)'}, expected ${buildId}`)
    } catch (err) {
      found.push(`/${slug}/ could not be fetched (${err.name ?? err})`)
    }
  }
  return found
}

// A fresh deploy can take a few seconds to reach every edge location, so look more than once before concluding.
let remaining = []
for (let i = 1; i <= ATTEMPTS; i += 1) {
  remaining = await problems()
  if (remaining.length === 0) break
  console.log(`verify-deploy: attempt ${i}/${ATTEMPTS} - ${remaining.join('; ')}`)
  if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, DELAY_MS))
}
if (remaining.length > 0) {
  await fail(`the live storefront does not match this build after ${ATTEMPTS} checks: ${remaining.join('; ')}`)
}

// Overtaken? Ask which publish each product is at NOW.
try {
  const res = await fetch(`${WORKER_URL}/ci/snapshots?summary=1`, {
    signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${SECRET}` },
  })
  if (res.ok) {
    const { snapshots } = await res.json()
    const current = Object.fromEntries(snapshots.map((s) => [s.slug, s.publishRef]))
    const moved = slugs.find((s) => current[s] !== expected[s])
    const extra = Object.keys(current).find((s) => !(s in expected))
    if (moved || extra) {
      await fail(`superseded: ${moved ? `/${moved}/ was published again` : `/${extra}/ was published`} while this build ran. The newer publish is built by its own run.`)
    }
  } else {
    console.warn(`verify-deploy: could not check for newer publishes (HTTP ${res.status}); continuing.`)
  }
} catch (err) {
  console.warn(`verify-deploy: could not check for newer publishes: ${err.message}; continuing.`)
}

const verdict = await post('mark-verified', {}, { retries: 4 })
let status = null
try { status = JSON.parse(verdict.text).status } catch { /* not JSON */ }
if (!verdict.ok || status !== 'verified') {
  await fail(`the Worker did not accept the build as verified (HTTP ${verdict.status}): ${verdict.text}`)
}
console.log(`verify-deploy: OK - ${slugs.length} product page(s) verified against their publish refs.`)
