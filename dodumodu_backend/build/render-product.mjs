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

// Escapes < and > as the six characters \u003c / \u003e so JSON-LD inside <script> cannot be
// terminated early by a value containing </script>. (The replacement strings must be written
// '\\u003c': a bare '\u003c' in JS source is just the character "<", which escaped nothing.)
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
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
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

// ---- URLs -----------------------------------------------------------------
// The same rule the browser uses (orchestrate.js mediaUrl): an absolute URL is used as-is,
// anything else is an R2 key under the image delivery base. Using the identical URL for the
// static hero and for the carousel's first slide means the browser fetches the image once.
export function mediaUrl(key, deliveryBase = '/media') {
  if (typeof key !== 'string' || key === '') return ''
  if (/^https?:\/\//i.test(key)) return key
  return `${String(deliveryBase).replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`
}
// Crawlers (WhatsApp, Facebook, X) need absolute URLs; a path is resolved against the site origin.
export function absoluteUrl(url, siteUrl = '') {
  if (!url || /^https?:\/\//i.test(url) || !siteUrl) return url
  return `${siteUrl}${url.startsWith('/') ? '' : '/'}${url}`
}
const originOf = (url) => { try { return new URL(url).origin } catch { return '' } }
const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' }
const imageTypeOf = (url) => IMAGE_TYPES[(String(url).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase()] ?? ''

// Build the JSON-LD Product block from snapshot data, escaping every string.
function jsonLd(snapshot, canonicalUrl, imageUrls) {
  const p = snapshot.product
  const rating = snapshot.page?.ratingValue ?? '4.9'
  const count = snapshot.page?.ratingCount ?? '0'
  const price = String(Number(p.price ?? 0) / 100)
  const images = imageUrls.slice(0, 5).map((u) => `"${escapeJsonString(u)}"`).join(',')
  return [
    '{',
    '"@context": "https://schema.org",',
    '"@graph": [',
    '{',
    '"@type": "Product",',
    `"@id": "${escapeJsonString(canonicalUrl)}#product",`,
    `"name": "${escapeJsonString(p.name)}",`,
    `"image": [${images}],`,
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

// ---- Page content blocks ----------------------------------------------------
// product_pages stores benefits / how-to / FAQ / trust badges as arrays of objects (see
// validation/adminSchema.ts). They used to be pasted into the page as if they were HTML,
// which printed "[object Object]". Every field is escaped; empty lists drop their section.
const SPRITE_ICONS = new Set(['check', 'truck', 'shield', 'phone', 'clock', 'warning'])
function iconHtml(icon, cls = 'icon') {
  const name = String(icon ?? '').trim()
  if (SPRITE_ICONS.has(name)) return `<svg class="${cls}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`
  // The admin allows an emoji as well as a sprite name; anything else falls back to the check mark.
  if (name && name.length <= 8 && !/^[a-z0-9_-]+$/i.test(name)) return `<span aria-hidden="true">${escapeHtml(name)}</span>`
  return `<svg class="${cls}" aria-hidden="true"><use href="#icon-check"></use></svg>`
}
const list = (v) => (Array.isArray(v) ? v : [])

const DEFAULT_TRUST = [
  { icon: 'shield', text: 'Dermatologist tested' },
  { icon: 'truck', text: 'Pay on delivery available' },
  { icon: 'check', text: '10,000+ happy customers' },
]

function benefitsSection(page) {
  const items = list(page.benefits)
  if (!items.length) return ''
  const lis = items.map((b) =>
    `<li class="benefit-card">${iconHtml(b.icon, 'icon icon--orange')}<div><strong>${escapeHtml(b.title)}</strong><span>${escapeHtml(b.body)}</span></div></li>`).join('')
  return `<section id="benefits" class="section lazy-section" aria-labelledby="benefits-title"><h2 id="benefits-title">${escapeHtml(page.whyLoveTitle ?? 'Why Nigerian Women Love This Serum')}</h2><ul class="benefits-grid">${lis}</ul></section>`
}
function howToSection(page) {
  const items = list(page.howToUse)
  if (!items.length) return ''
  const lis = items.map((s) => `<li><strong>${escapeHtml(String(s.title).replace(/:+$/, ''))}:</strong> ${escapeHtml(s.body)}</li>`).join('')
  return `<section class="section lazy-section" aria-labelledby="how-to-use-title"><h2 id="how-to-use-title">${escapeHtml(page.howToUseTitle ?? 'How To Use For Best Results')}</h2><ol class="steps-list">${lis}</ol></section>`
}
function faqSection(page) {
  const items = list(page.faq)
  if (!items.length) return ''
  const ds = items.map((f, i) => `<details class="faq-item"${i === 0 ? ' open' : ''}><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a)}</p></details>`).join('')
  return `<section class="section lazy-section" aria-labelledby="faq-title"><h2 id="faq-title">Frequently Asked Questions</h2>${ds}</section>`
}
function testimonialsSection(snapshot, deliveryBase) {
  const items = list(snapshot.testimonials).slice(0, 4)
  if (!items.length) return ''
  const cards = items.map((t) => {
    const src = mediaUrl(t.r2Key, deliveryBase)
    const img = src ? `<img class="testimonial-image" src="${escapeUrl(src)}" alt="${escapeHtmlAttr(t.title ?? '')}" width="64" height="64" loading="lazy" decoding="async">` : ''
    return `<div class="testimonial-card">${img}<div><div class="testimonial-title">${escapeHtml(t.title ?? '')}</div><p class="testimonial-description">${escapeHtml(t.description ?? '')}</p></div></div>`
  }).join('')
  return `<section class="section lazy-section" aria-labelledby="testimonials-title"><h2 id="testimonials-title">What customers say</h2><div id="testimonials"><div class="testimonials-list">${cards}</div></div></section>`
}
function trustRow(page) {
  const badges = list(page.trustBadges).length ? list(page.trustBadges) : DEFAULT_TRUST
  return `<div class="trust-row" role="list">${badges.map((b) => `<div class="trust-item" role="listitem">${iconHtml(b.icon)} ${escapeHtml(b.text)}</div>`).join('')}</div>`
}

/**
 * renderProduct(snapshot, opts) => html
 *
 * opts (all optional so the function stays pure and testable):
 *   css, jsPath, csp, buildId, maxOrderQuantity
 *   siteUrl          real https origin, no trailing slash. Makes canonical, og:url and og:image absolute.
 *   deliveryBase     where uploaded images are served from (default /media), same as the browser's.
 *   sprite, runtimeConfig, inlineScripts, turnstileSiteKey
 *                    taken by scripts/build-site.mjs from the built product page the CSP hashes were
 *                    computed from, so a published page carries byte-identical copies.
 */
export function renderProduct(snapshot, opts = {}) {
  const { css = '', jsPath = '/site.js', csp = '', buildId = '', siteUrl = '', deliveryBase = '/media' } = opts

  if (!validateSlug(snapshot.slug)) {
    throw new Error(`refusing to render product with invalid slug: ${JSON.stringify(snapshot.slug)}`)
  }

  // The page carries this id as <meta name="storefront-publish-id">, which the deploy verifier and the admin
  // LIVE check compare against what was published. A missing id used to render as pub_0 and fail every
  // verification with no hint why, so it is an error here instead.
  if (!Number.isInteger(snapshot.publishId) || snapshot.publishId <= 0) {
    throw new Error(`refusing to render ${snapshot.slug} without its publish id (got ${JSON.stringify(snapshot.publishId)})`)
  }
  const p = snapshot.product
  const page = snapshot.page ?? {}
  const publishId = `pub_${snapshot.publishId}`

  // The Worker serves each page at /<slug>/ (and /<slug>); crawlers need the absolute form.
  const canonicalUrl = `${siteUrl}/${snapshot.slug}/`

  const images = list(snapshot.images)
  const hero = images[0]
  const heroSrc = hero ? mediaUrl(hero.r2Key, deliveryBase) : ''
  const heroAlt = page.heroAlt || p.name
  const ogImage = absoluteUrl(heroSrc, siteUrl)
  const title = `${p.name} - DODUMODU`
  const description = p.description ?? ''

  const ogImageTags = ogImage
    ? [
        `<meta property="og:image" content="${escapeUrl(ogImage)}">`,
        ...(ogImage.startsWith('https://') ? [`<meta property="og:image:secure_url" content="${escapeUrl(ogImage)}">`] : []),
        ...(imageTypeOf(ogImage) ? [`<meta property="og:image:type" content="${imageTypeOf(ogImage)}">`] : []),
        ...(hero.width && hero.height ? [`<meta property="og:image:width" content="${Number(hero.width)}">`, `<meta property="og:image:height" content="${Number(hero.height)}">`] : []),
        `<meta property="og:image:alt" content="${escapeHtmlAttr(heroAlt)}">`,
      ].join('\n')
    : ''
  const twitterImageTags = ogImage
    ? `<meta name="twitter:image" content="${escapeUrl(ogImage)}">\n<meta name="twitter:image:alt" content="${escapeHtmlAttr(heroAlt)}">`
    : ''

  // Static hero: the same file the carousel shows first, so the swap on load is not a second download.
  const heroHtml = heroSrc
    ? `<picture><img class="hero-fallback" src="${escapeUrl(heroSrc)}" alt="${escapeHtmlAttr(heroAlt)}" width="${Number(hero.width) || 640}" height="${Number(hero.height) || 640}" fetchpriority="high" decoding="async"></picture>`
    : ''
  const heroOrigin = originOf(heroSrc)
  const sameOrigin = heroOrigin && heroOrigin === originOf(siteUrl)
  const preconnect = heroOrigin && !sameOrigin ? `<link rel="preconnect" href="${escapeUrl(heroOrigin)}">` : ''
  const preload = heroSrc ? `<link rel="preload" as="image" href="${escapeUrl(heroSrc)}" fetchpriority="high">` : ''

  const ldImages = images.map((i) => absoluteUrl(mediaUrl(i.r2Key, deliveryBase), siteUrl)).filter(Boolean)

  // Slots: key -> escaped replacement value.
  const slots = {
    PAGE_TITLE: escapeHtmlAttr(title),
    META_DESCRIPTION: escapeHtmlAttr(description),
    STOREFRONT_PUBLISH_ID: publishId,
    STOREFRONT_BUILD_ID: escapeHtmlAttr(buildId),
    CANONICAL_URL: escapeUrl(canonicalUrl),
    OG_TITLE: escapeHtmlAttr(title),
    OG_DESCRIPTION: escapeHtmlAttr(description),
    OG_URL: escapeUrl(canonicalUrl),
    OG_IMAGE_TAGS: ogImageTags,
    PRODUCT_PRICE_AMOUNT: String(Math.round(Number(p.price ?? 0) / 100)),
    TWITTER_TITLE: escapeHtmlAttr(title),
    TWITTER_DESCRIPTION: escapeHtmlAttr(description),
    TWITTER_IMAGE_TAGS: twitterImageTags,
    HERO_PRECONNECT: preconnect,
    HERO_PRELOAD: preload,
    HERO_HTML: heroHtml,
    BODY_DATA_SLUG: escapeHtmlAttr(snapshot.slug),
    BODY_DATA_PRODUCT_ID: String(p.id ?? 0),
    BREADCRUMB_NAME: escapeHtml(p.name),
    PRODUCT_NAME: escapeHtml(p.name),
    PRICE_DISPLAY: formatPrice(p.price),
    RATING_VALUE: escapeHtml(page.ratingValue ?? '4.9'),
    RATING_COUNT: escapeHtml(page.ratingCount ?? '0'),
    DELIVERY_BADGE: escapeHtml(page.deliveryBadge || 'Free delivery in Lagos & Ogun'),
    SUMMARY_BLOCK: page.summaryHtml ? `<p>${page.summaryHtml}</p>` : '', // sanitised rich text (adminSchema), inserted as-is
    TRUST_ROW: trustRow(page),
    BENEFITS_SECTION: benefitsSection(page),
    TESTIMONIALS_SECTION: testimonialsSection(snapshot, deliveryBase),
    HOW_TO_SECTION: howToSection(page),
    FAQ_SECTION: faqSection(page),
    CTA_TEXT: escapeHtml(page.ctaText || 'Place your order'),
    ORDER_INTRO: escapeHtml('Fill the short form below. Pay cash or transfer when your package arrives.'),
    MAX_ORDER_QUANTITY: String(Number(opts.maxOrderQuantity ?? 20)),
    TURNSTILE_SITE_KEY: escapeHtmlAttr(opts.turnstileSiteKey ?? ''),
    CSS_INLINE: css,
    APP_JS_PATH: jsPath.replace(/^\//, ''),
    CSP_META: csp ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(csp)}">` : '',
    RUNTIME_CONFIG: opts.runtimeConfig ?? '',
    INLINE_SCRIPTS: opts.inlineScripts ?? '',
    SVG_SPRITE: opts.sprite ?? '',
    JSON_LD: `<script type="application/ld+json">${jsonLd(snapshot, canonicalUrl, ldImages)}</script>`,
  }

  // One pass over the TEMPLATE: a value that happens to contain "{{SOMETHING}}" (a product
  // description, say) is data and is never re-scanned. An unknown slot in the template is a
  // template/renderer mismatch, and shipping literal {{SLOT}} text would be a bug, so fail hard.
  const unknown = []
  const html = TEMPLATE.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (Object.hasOwn(slots, key)) return slots[key]
    unknown.push(match)
    return match
  })
  if (unknown.length) throw new Error(`unreplaced template slots: ${unknown.join(', ')}`)
  return html
}
