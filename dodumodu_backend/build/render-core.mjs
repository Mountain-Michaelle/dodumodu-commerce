// build/render-core.mjs — pure product-page renderer (no file access, so it also runs inside the Worker).
// Reads build/product.template.html and fills {{SLOT}} placeholders from a
// publish snapshot. Every untrusted value is escaped for its output context:
// HTML text, HTML attributes, URLs, or JSON-LD strings. The snapshot's
// summaryHtml (already-sanitised rich text from product_pages) is inserted
// as-is; nothing else is trusted.
//
// No network, no database, no framework: pure string transformation.
// Exported as a single renderProduct(snapshot, {css, js, csp, buildId}) => html.
// One URL builder for build time and browser time, so the page can never advertise a width the browser's carousel
// would not also request (the browser then reuses the already-downloaded first photo).
import { imageUrl, srcsetFor, DEFAULT_SIZES, DEFAULT_QUALITY, DEFAULT_WIDTHS } from '../../dodumodu_site/shared/scripts/imageUrls.js'


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
/**
 * Everything the order form needs to price and validate an order, printed into the page as inert JSON (type=application/json
 * is never executed, so it needs no CSP allowance). The storefront reads this instead of calling GET /page-data/<slug>, so a
 * published page makes NO backend request to render or become interactive. It comes from the same verified snapshot as the rest
 * of the page, which is what makes "admin changes regenerate the page" the whole update mechanism.
 *
 * Delivery options are the full set on purpose: the page works out the 3pm WAT cutoff from the visitor's own clock
 * (shared/scripts/deliveryOptions.js), and a list frozen at publish time would hide "today" from everyone published after 3pm.
 */
function pageDataScript(snapshot) {
  const data = {
    product: snapshot.product,
    discountTiers: list(snapshot.discountTiers),
    maxOrderQuantity: snapshot.maxOrderQuantity,
    paymentRules: snapshot.paymentRules ?? null,
    deliveryOptions: ['today', 'tomorrow', 'next_tomorrow'],
    images: list(snapshot.images).map((i) => ({ r2Key: i.r2Key, altText: i.altText ?? '' })),
    testimonials: list(snapshot.testimonials).map((t) => ({ r2Key: t.r2Key ?? null, title: t.title ?? '', description: t.description ?? '', kind: t.kind === 'whatsapp' ? 'whatsapp' : 'review' })),
  }
  // "<" and the two JS line separators are escaped so no value can close the tag or break a parser.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `<script type="application/json" id="page-data">${json}</script>`
}
// A review photo is shown ~300px wide on desktop and about the card width on a phone; a screenshot the same. The default
// testimonial `sizes` (480px) would make a phone download more than it draws.
const TESTIMONIAL_SIZES = '(max-width: 768px) 92vw, 300px'

// One lazily-loaded, responsive testimonial image: the browser picks the smallest candidate that fits, fetches it only when it
// nears the viewport (loading=lazy), decodes it off the main thread (decoding=async) and ranks it below everything else.
function lazyTestimonialImg(cls, t, deliveryBase, mode, alt, size) {
  const o = { key: t.r2Key, slot: 'testimonial', mode, deliveryBase }
  const widths = DEFAULT_WIDTHS.testimonial
  const src = imageUrl({ ...o, width: widths[widths.length - 1], quality: DEFAULT_QUALITY.testimonial })
  if (!src) return ''
  const set = srcsetFor(o)
  return `<img class="${cls}" src="${escapeUrl(src)}"${set ? ` srcset="${escapeHtmlAttr(set)}" sizes="${TESTIMONIAL_SIZES}"` : ''} alt="${escapeHtmlAttr(alt)}" loading="lazy" decoding="async" fetchpriority="low"${size}>`
}

function testimonialsSection(snapshot, deliveryBase, mode = 'transform') {
  const items = list(snapshot.testimonials)
  const reviews = items.filter((t) => t.kind !== 'whatsapp').map((t) => {
    const title = String(t.title ?? '')
    const text = `<div class="testimonial-body"><p class="testimonial-title">${escapeHtml(title)}</p><p class="testimonial-description">${escapeHtml(t.description ?? '')}</p></div>`
    const photo = t.r2Key ? lazyTestimonialImg('testimonial-image', t, deliveryBase, mode, '', ' width="480" height="600"') : ''
    if (photo) return `<div class="testimonial-card has-photo">${photo}${text}</div>`
    return `<div class="testimonial-card"><span class="testimonial-avatar" aria-hidden="true">${escapeHtml((title || '?').trim().charAt(0).toUpperCase())}</span>${text}</div>`
  }).join('')
  return reviews
    ? `<section class="section" aria-labelledby="testimonials-title"><h2 id="testimonials-title">What customers say</h2><div id="testimonials"><div class="testimonials-list">${reviews}</div></div></section>`
    : ''
}

function whatsappSection(snapshot, deliveryBase, mode = 'transform') {
  // WhatsApp screenshots are not part of a review card: they are their own section with their own H2 and carry no text,
  // only the screenshots.
  const items = list(snapshot.testimonials)
  const dim = (n) => (Number.isInteger(n) && n > 0 ? n : 0)
  const shots = items.filter((t) => t.kind === 'whatsapp').map((t) => {
    const w = dim(t.width), h = dim(t.height) // the real size when the admin recorded it (no layout shift while loading)
    return lazyTestimonialImg('testimonial-screenshot', t, deliveryBase, mode, `WhatsApp message from ${String(t.title ?? 'a customer')}`, w && h ? ` width="${w}" height="${h}"` : '')
  }).filter(Boolean).join('')
  return shots
    ? `<section class="section" aria-labelledby="whatsapp-title"><h2 id="whatsapp-title">Real WhatsApp messages from customers</h2><div class="screenshot-grid">${shots}</div></section>`
    : ''
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
export function renderProductWith(template, snapshot, opts = {}) {
  const { css = '', jsPath = '/site.js', csp = '', buildId = '', siteUrl = '', deliveryBase = '/media' } = opts

  if (!validateSlug(snapshot.slug)) {
    throw new Error(`refusing to render product with invalid slug: ${JSON.stringify(snapshot.slug)}`)
  }

  const p = snapshot.product
  const page = snapshot.page ?? {}
  // The public marker of this publish (pub_ + 20 hex). It must be passed in: a page without one could never be
  // verified as live, so rendering without it is an error rather than a silent "pub_0".
  const publishId = snapshot.publishRef
  if (!/^pub_[0-9a-f]{20}$/.test(publishId ?? '')) {
    throw new Error(`refusing to render ${snapshot.slug}: missing or malformed publishRef`)
  }

  // The Worker serves each page at /<slug>/ (and /<slug>); crawlers need the absolute form.
  const canonicalUrl = `${siteUrl}/${snapshot.slug}/`

  const images = list(snapshot.images)
  const hero = images[0]
  const heroSrc = hero ? mediaUrl(hero.r2Key, deliveryBase) : ''
  const heroAlt = page.heroAlt || p.name
  const ogImage = absoluteUrl(heroSrc, siteUrl)
  // The admin's SEO fields were saved and published but never used. Fall back to the old derived values when they are empty.
  const title = (p.seoTitle && String(p.seoTitle).trim()) || `${p.name} - DODUMODU`
  const description = (p.seoDescription && String(p.seoDescription).trim()) || (p.description ?? '')

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

  // Static first photo: byte-for-byte what the carousel requests first (same src, srcset and sizes), so the
  // script taking over later costs no second download. It is also preloaded with the same srcset.
  const imageMode = opts.imageMode === 'derivative' ? 'derivative' : 'transform'
  const imgOpts = { key: hero?.r2Key, slot: 'gallery', mode: imageMode, deliveryBase }
  const widths = DEFAULT_WIDTHS.gallery
  const midWidth = widths[Math.min(1, widths.length - 1)]
  const heroSrcOpt = hero ? imageUrl({ ...imgOpts, width: midWidth, quality: DEFAULT_QUALITY.gallery }) : ''
  const heroSrcset = hero ? srcsetFor(imgOpts) : ''
  // The WHOLE gallery is printed as the finished carousel track (slides only; arrows and dots are an absolutely-placed
  // overlay the script adds, so adding them moves nothing). The script then only wires it up. Before, the script deleted
  // the painted hero and built a new one, which showed a blank box on slow phones and was HTML generated after delivery.
  // The first slide is byte-for-byte the old hero image (same src, srcset, sizes), so the preload below still matches.
  const slideHtml = (img, i) => {
    const src = i === 0 ? heroSrcOpt : imageUrl({ key: img.r2Key, slot: 'gallery', mode: imageMode, deliveryBase, width: midWidth, quality: DEFAULT_QUALITY.gallery })
    if (!src) return ''
    const set = i === 0 ? heroSrcset : srcsetFor({ key: img.r2Key, slot: 'gallery', mode: imageMode, deliveryBase })
    const alt = i === 0 ? heroAlt : (img.altText ?? '')
    const dim = widths[widths.length - 1]
    return `<div class="carousel-slide"><img src="${escapeUrl(src)}"${set ? ` srcset="${escapeHtmlAttr(set)}" sizes="${escapeHtmlAttr(DEFAULT_SIZES.gallery)}"` : ''} alt="${escapeHtmlAttr(alt)}" width="${dim}" height="${dim}"${i === 0 ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></div>`
  }
  const slides = heroSrcOpt ? images.map(slideHtml).join('') : ''
  const heroHtml = slides
    ? `<div class="carousel-wrap"><div class="carousel" role="region" aria-roledescription="carousel" aria-label="Product photos" tabindex="0">${slides}</div></div>`
    : ''
  const heroOrigin = originOf(heroSrcOpt)
  const sameOrigin = heroOrigin && heroOrigin === originOf(siteUrl)
  const preconnect = heroOrigin && !sameOrigin ? `<link rel="preconnect" href="${escapeUrl(heroOrigin)}">` : ''
  const preload = heroSrcOpt
    ? `<link rel="preload" as="image" href="${escapeUrl(heroSrcOpt)}"${heroSrcset ? ` imagesrcset="${escapeHtmlAttr(heroSrcset)}" imagesizes="${escapeHtmlAttr(DEFAULT_SIZES.gallery)}"` : ''} fetchpriority="high">`
    : ''
  const carouselAttrs = ''

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
    CAROUSEL_ATTRS: carouselAttrs,
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
    TESTIMONIALS_SECTION: testimonialsSection(snapshot, deliveryBase, imageMode),
    WHATSAPP_SECTION: whatsappSection(snapshot, deliveryBase, imageMode),
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
    PAGE_DATA: pageDataScript(snapshot),
    INLINE_SCRIPTS: opts.inlineScripts ?? '',
    SVG_SPRITE: opts.sprite ?? '',
    JSON_LD: `<script type="application/ld+json">${jsonLd(snapshot, canonicalUrl, ldImages)}</script>`,
  }

  // One pass over the TEMPLATE: a value that happens to contain "{{SOMETHING}}" (a product
  // description, say) is data and is never re-scanned. An unknown slot in the template is a
  // template/renderer mismatch, and shipping literal {{SLOT}} text would be a bug, so fail hard.
  const unknown = []
  const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (Object.hasOwn(slots, key)) return slots[key]
    unknown.push(match)
    return match
  })
  if (unknown.length) throw new Error(`unreplaced template slots: ${unknown.join(', ')}`)
  return html
}
