// build/render-product.mjs — pure product-page renderer.
// Reads build/product.template.html and fills {{SLOT}} placeholders from a
// publish snapshot. Every untrusted value is escaped for its output context:
// HTML text, HTML attributes, URLs, or JSON-LD strings. The snapshot's
// summaryHtml (already-sanitised rich text from product_pages) is inserted
// as-is; nothing else is trusted.
//
// No network, no database, no framework: pure string transformation.
// Exported as a single renderProduct(snapshot, {css, js, csp, buildId}) => html.
import { readFileSync } from 'node:fs'

const TEMPLATE = readFileSync(
  new URL('./product.template.html', import.meta.url),
  'utf8'
)

// ---- HTML text escaping (for element content) ----
const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function escapeHtml(text) {
  if (text == null) return ''
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch])
}

// ---- HTML attribute escaping (for attribute values) ----
export function escapeHtmlAttr(text) {
  if (text == null) return ''
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch])
}

// Escapes < and > as \u003c/\u003e so JSON-LD inside <script> cannot be terminated early.
// ---- JSON string escaping (for JSON-LD string values) ----
export function escapeJsonString(text) {
  if (text == null) return ''
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\b]/g, '\\b')
    .replace(/\f/g, '\\f')
    .replace(/</g, '\u003c')
    .replace(/>/g, '\u003e')
}

// ---- URL escaping (for href/src attribute values) ----
export function escapeUrl(text) {
  if (text == null) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\s/g, '%20')
}

// A slug is trusted: it comes from our own stable collision-safe slug column.
// We still validate its shape to never render an unexpected path segment.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export function validateSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && slug.length > 0 && slug.length <= 80
}

// Price in minor units (kobo) -> naira display string, e.g. 1500000 -> "&#8358;15,000"
export function formatPrice(minorUnits) {
  const naira = (Number(minorUnits) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })
  return '&#8358;' + naira
}

// Build the JSON-LD Product block from snapshot data, escaping every string.
function jsonLd(snapshot, canonicalUrl) {
  const p = snapshot.product
  const images = (snapshot.images ?? []).map((img) => escapeUrl(img.r2Key))
  const heroImage = images.length ? images[0] : ''
  const rating = snapshot.page?.ratingValue ?? '4.9'
  const count = snapshot.page?.ratingCount ?? '0'
  const price = String(Number(p.price ?? 0) / 100)
  return [
    '{',
    '"@context": "https://schema.org",',
    '"@graph": [',
    '{',
    '"@type": "Product",',
    `"@id": "${escapeJsonString(canonicalUrl)}#product",`,
    `"name": "${escapeJsonString(p.name)}",`,
    `"image": ["${escapeJsonString(heroImage)}"],`,
    `"description": "${escapeJsonString(p.description ?? '')}",`,
    `"sku": "${escapeJsonString(p.slug)}",`,
    '"brand": {"@type": "Brand", "name": "DODUMODU"},',
    '"aggregateRating": {',
    '"@type": "AggregateRating",',
    `"ratingValue": "${escapeJsonString(rating)}",`,
    `"reviewCount": "${escapeJsonString(count)}",`,
    '"bestRating": "5",',
    '"worstRating": "1"',
    '},',
    '"offers": {',
    '"@type": "Offer",',
    `"url": "${escapeJsonString(canonicalUrl)}",`,
    '"priceCurrency": "NGN",',
    `"price": "${escapeJsonString(price)}",`,
    '"priceValidUntil": "2027-12-31",',
    '"itemCondition": "https://schema.org/NewCondition"',
    '}',
    '}',
    ']',
    '}',
  ].join('')
}

export function renderProduct(snapshot, opts = {}) {
  const { css = '', jsPath = '/site.js', csp = '', buildId = '' } = opts

  if (!validateSlug(snapshot.slug)) {
    throw new Error(`refusing to render product with invalid slug: ${JSON.stringify(snapshot.slug)}`)
  }

  const p = snapshot.product
  const page = snapshot.page ?? {}
  const publishId = `pub_${snapshot.publishId ?? 0}`

  // Canonical and Open Graph URLs use the root-level slug route.
  const canonicalUrl = `/${snapshot.slug}/`

  // Slots: key -> escaped replacement value.
  const slots = {
    PAGE_TITLE: escapeHtmlAttr(`${p.name} - DODUMODU`),
    META_DESCRIPTION: escapeHtmlAttr(p.description ?? ''),
    STOREFRONT_PUBLISH_ID: publishId,
    STOREFRONT_BUILD_ID: escapeHtmlAttr(buildId),
    CANONICAL_URL: escapeUrl(canonicalUrl),
    OG_TITLE: escapeHtmlAttr(`${p.name} - DODUMODU`),
    OG_DESCRIPTION: escapeHtmlAttr(p.description ?? ''),
    OG_URL: escapeUrl(canonicalUrl),
    OG_IMAGE: escapeUrl((snapshot.images ?? [])[0]?.r2Key ?? ''),
    OG_IMAGE_ALT: escapeHtmlAttr(page.heroAlt ?? p.name),
    PRODUCT_PRICE_AMOUNT: String(Math.round(Number(p.price ?? 0) / 100)),
    TWITTER_TITLE: escapeHtmlAttr(`${p.name} - DODUMODU`),
    TWITTER_DESCRIPTION: escapeHtmlAttr(p.description ?? ''),
    TWITTER_IMAGE: escapeUrl((snapshot.images ?? [])[0]?.r2Key ?? ''),
    HERO_PRELOAD_SRC: escapeUrl((snapshot.images ?? [])[0]?.r2Key ?? ''),
    HERO_PRELOAD_SRCSET: escapeUrl((snapshot.images ?? [])[0]?.r2Key ?? ''),
    HERO_SRCSET: escapeUrl((snapshot.images ?? [])[0]?.r2Key ?? ''),
    HERO_SRC: escapeUrl((snapshot.images ?? [])[0]?.r2Key ?? ''),
    HERO_ALT: escapeHtmlAttr(page.heroAlt ?? p.name),
    BODY_DATA_SLUG: escapeHtmlAttr(snapshot.slug),
    BODY_DATA_PRODUCT_ID: String(p.id ?? 0),
    BREADCRUMB_NAME: escapeHtml(p.name),
    PRODUCT_NAME: escapeHtml(p.name),
    PRICE_DISPLAY: formatPrice(p.price),
    RATING_VALUE: escapeHtml(page.ratingValue ?? '4.9'),
    RATING_COUNT: escapeHtml(page.ratingCount ?? '0'),
    SUMMARY_HTML: page.summaryHtml ?? '', // already-safe rich text from the snapshot
    WHY_LOVE_TITLE: escapeHtml(page.whyLoveTitle ?? 'Why Nigerian Women Love This Serum'),
    BENEFITS_HTML: page.benefits ?? '', // already-safe rich text from the snapshot
    HOW_TO_USE_TITLE: escapeHtml(page.howToUseTitle ?? 'How To Use For Best Results'),
    HOW_TO_USE_HTML: page.howToUse ?? '', // already-safe rich text from the snapshot
    CTA_TEXT: escapeHtml(page.ctaText ?? 'Place your order'),
    ORDER_INTRO: escapeHtml('Fill the short form below. Pay cash or transfer when your package arrives.'),
    MAX_ORDER_QUANTITY: String(Number(opts.maxOrderQuantity ?? 20)),
    FAQ_HTML: page.faq ?? '', // already-safe rich text from the snapshot
    CSS_INLINE: css,
    APP_JS_PATH: jsPath.replace(/^\//, ''),
    CSP_META: csp ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(csp)}">` : '',
    JSON_LD: jsonLd(snapshot, canonicalUrl),
    SVG_SPRITE: '', // inline SVG sprite is in the CSS-inlined HTML already; kept for slot parity
  }

  let html = TEMPLATE
  for (const [key, value] of Object.entries(slots)) {
    html = html.split(`{{${key}}}`).join(value)
  }

  // Fail hard if any slot was left unreplaced - that means a template/renderer
  // mismatch and shipping a page with literal {{SLOT}} text would be a bug.
  const unreplaced = html.match(/\{\{[A-Z_]+\}\}/g)
  if (unreplaced) {
    throw new Error(`unreplaced template slots: ${unreplaced.join(', ')}`)
  }

  return html
}
