import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderProduct, escapeHtml, escapeHtmlAttr, escapeJsonString, escapeUrl, validateSlug, formatPrice, mediaUrl, absoluteUrl } from './render-product.mjs'

const baseSnapshot = {
  publishRef: 'pub_0123456789abcdef0123',
  slug: 'glow-serum',
  product: {
    id: 1,
    slug: 'glow-serum',
    name: 'Radiance Glow Serum',
    description: 'A bright serum with <script>alert("xss")</script>',
    price: 1500000,
    packageOptions: [],
    seoTitle: null,
    seoDescription: null,
  },
  page: {
    summaryHtml: '<p>Already safe <strong>rich</strong> text.</p>',
    benefits: [{ icon: 'shield', title: 'Benefit <one>', body: 'Body & more' }, { icon: '🌿', title: 'Benefit two', body: 'Second' }],
    howToUse: [{ title: 'Cleanse', body: 'Wash your face.' }, { title: 'Apply:', body: 'Use 3 drops.' }],
    faq: [{ q: 'Is it safe?', a: 'Yes, <b>very</b>.' }, { q: 'How fast?', a: '24 hours.' }],
    whyLoveTitle: 'Why Love It',
    howToUseTitle: 'How to Use',
    ratingValue: '4.9',
    ratingCount: '1048',
    heroAlt: 'Serum bottle with dropper',
    ctaText: 'Place your order',
  },
  images: [{ r2Key: 'uploads/hero.jpg', altText: 'hero', width: 640, height: 640, variants: [] }],
  testimonials: [{ r2Key: 'uploads/t1.jpg', title: 'Amaka O. - Lagos', description: 'Faded in 10 days <3', kind: 'review' }],
  deliveryOptions: [],
  discountTiers: [],
  maxOrderQuantity: 20,
  paymentRules: {},
  freeDeliveryStates: [],
}

test('escapeHtml escapes dangerous markup', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

test('escapeHtmlAttr escapes attribute values', () => {
  assert.equal(escapeHtmlAttr('onload="evil()"'), 'onload=&quot;evil()&quot;')
  assert.equal(escapeHtmlAttr(null), '')
})

test('escapeJsonString escapes JSON string content', () => {
  assert.equal(escapeJsonString('he said "hi"'), 'he said \\"hi\\"')
  assert.equal(escapeJsonString('line1\nline2'), 'line1\\nline2')
  assert.equal(escapeJsonString(null), '')
})

test('escapeUrl escapes URLs for attributes', () => {
  assert.equal(escapeUrl('http://example.com?a=1&b=2'), 'http://example.com?a=1&amp;b=2')
  assert.equal(escapeUrl(null), '')
})

test('validateSlug accepts stable slugs and rejects traversal', () => {
  assert.ok(validateSlug('glow-serum'))
  assert.ok(validateSlug('a-b-c'))
  assert.ok(!validateSlug('../etc/passwd'))
  assert.ok(!validateSlug('Glow-Serum'))
  assert.ok(!validateSlug(''))
  assert.ok(!validateSlug(null))
  assert.ok(!validateSlug('a'.repeat(81)))
})

test('formatPrice converts minor units to naira display', () => {
  assert.equal(formatPrice(1500000), '&#8358;15,000.00')
  assert.equal(formatPrice(2500), '&#8358;25.00')
})

test('renderProduct fills all slots and leaves no unreplaced placeholders', () => {
  const html = renderProduct(baseSnapshot, { css: 'body{}', jsPath: '/site.abcd.js', csp: "default-src 'self'", buildId: 'build_123' })
  assert.ok(html.includes('<title>Radiance Glow Serum - DODUMODU</title>'))
  assert.ok(html.includes('pub_0123456789abcdef0123'))
  assert.ok(html.includes('build_123'))
  assert.ok(html.includes('/glow-serum/'))
  assert.ok(html.includes('<meta name="storefront-publish-id" content="pub_0123456789abcdef0123">'))
  assert.ok(html.includes('<meta name="storefront-build-id" content="build_123">'))
  assert.ok(!html.match(/\{\{[A-Z_]+\}\}/), 'no unreplaced slots')
  assert.ok(html.includes('<body data-slug="glow-serum" data-product-id="1">'))
  assert.ok(html.includes('<h1 id="product-title">Radiance Glow Serum</h1>'))
  assert.ok(html.includes('<p><p>Already safe <strong>rich</strong> text.</p></p>') || html.includes('Already safe <strong>rich</strong> text.'))
})

test('renderProduct escapes untrusted product description in attributes', () => {
  const html = renderProduct(baseSnapshot, { css: '', jsPath: '/site.js' })
  assert.ok(html.includes('name="description" content="A bright serum with &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"'))
  assert.ok(html.includes('&lt;/script&gt;'))
})

test('renderProduct rejects invalid slugs', () => {
  assert.throws(() => renderProduct({ ...baseSnapshot, slug: '../etc' }, {}), /refusing to render/)
})

test('renderProduct includes JSON-LD with escaped strings', () => {
  const html = renderProduct(baseSnapshot, { css: '', jsPath: '/site.js' })
  assert.ok(html.includes('"@type": "Product"'))
  assert.ok(html.includes('"description": "A bright serum with \\u003cscript\\u003ealert(\\"xss\\")\\u003c/script\\u003e"'))
  assert.ok(html.includes('"@id": "/glow-serum/#product"'))
  // It is a real <script type="application/ld+json"> block (it used to be bare text printed in the page body),
  // and a value containing </script> cannot close it early.
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
  assert.ok(m, 'JSON-LD is wrapped in a script tag')
  assert.ok(!m[1].includes('<'), 'no raw < inside the JSON-LD block')
  assert.doesNotThrow(() => JSON.parse(m[1]))
  assert.equal(JSON.parse(m[1])['@graph'][0].description, 'A bright serum with <script>alert("xss")</script>')
})


// ---------------------------------------------------------------------------
// Link previews (WhatsApp, Facebook, X) and the hero
// ---------------------------------------------------------------------------
const SITE = 'https://shop.example.com'
const rich = (over = {}) => renderProduct(baseSnapshot, { css: 'body{}', jsPath: '/site.abcd.js', siteUrl: SITE, deliveryBase: 'https://media.example.com', ...over })

test('canonical, og:url and og:image are absolute so a crawler can use them', () => {
  const html = rich()
  assert.ok(html.includes(`<link rel="canonical" href="${SITE}/glow-serum/">`))
  assert.ok(html.includes(`<meta property="og:url" content="${SITE}/glow-serum/">`))
  assert.ok(html.includes('<meta property="og:image" content="https://media.example.com/uploads/hero.jpg">'))
  assert.ok(html.includes('<meta property="og:image:secure_url" content="https://media.example.com/uploads/hero.jpg">'))
  assert.ok(html.includes('<meta property="og:image:type" content="image/jpeg">'))
  assert.ok(html.includes('<meta property="og:image:width" content="640">'))
  assert.ok(html.includes('<meta property="og:image:height" content="640">'))
  assert.ok(html.includes('<meta name="twitter:image" content="https://media.example.com/uploads/hero.jpg">'))
  assert.ok(html.includes(`"@id": "${SITE}/glow-serum/#product"`))
})

test('a same-origin delivery base (/media) still yields an absolute og:image', () => {
  const html = rich({ deliveryBase: '/media' })
  assert.ok(html.includes(`<meta property="og:image" content="${SITE}/media/uploads/hero.jpg">`))
})

test('the OG tags come before the inline CSS so a crawler that reads only the start of the page sees them', () => {
  const html = rich({ css: 'x'.repeat(20000) })
  assert.ok(html.indexOf('og:image') < html.indexOf('<style>'))
  assert.ok(html.indexOf('og:title') < 3000)
})

test('the static hero is the real image (same URL the carousel will use), preloaded, with its origin preconnected', () => {
  const html = rich()
  assert.ok(html.includes('class="hero-fallback" src="https://media.example.com/uploads/hero.jpg"'))
  assert.ok(html.includes('alt="Serum bottle with dropper"'))
  assert.ok(html.includes('<link rel="preload" as="image" href="https://media.example.com/uploads/hero.jpg" fetchpriority="high">'))
  assert.ok(html.includes('<link rel="preconnect" href="https://media.example.com">'))
  assert.ok(!html.includes('picsum.photos'), 'no placeholder host baked into a real page')
  assert.ok(!html.includes('image/webp'), 'the preload no longer claims a type the file does not have')
  // same origin as the site: nothing to preconnect to
  assert.ok(!rich({ deliveryBase: '/media' }).includes('rel="preconnect"'))
})

test('an empty hero alt falls back to the product name (an empty string used to win)', () => {
  const html = renderProduct({ ...baseSnapshot, page: { ...baseSnapshot.page, heroAlt: '' } }, { siteUrl: SITE })
  assert.ok(html.includes('alt="Radiance Glow Serum"'))
})

test('a product with no images renders without a hero, preload or og:image', () => {
  const html = renderProduct({ ...baseSnapshot, images: [] }, { siteUrl: SITE })
  assert.ok(!html.includes('og:image'))
  assert.ok(!html.includes('rel="preload"'))
  assert.ok(!html.includes('hero-fallback'))
})

test('mediaUrl and absoluteUrl follow the browser rules', () => {
  assert.equal(mediaUrl('uploads/a.jpg', '/media/'), '/media/uploads/a.jpg')
  assert.equal(mediaUrl('https://cdn.example.com/a.jpg', '/media'), 'https://cdn.example.com/a.jpg')
  assert.equal(mediaUrl('', '/media'), '')
  assert.equal(absoluteUrl('/media/a.jpg', 'https://s.example'), 'https://s.example/media/a.jpg')
  assert.equal(absoluteUrl('https://x.example/a.jpg', 'https://s.example'), 'https://x.example/a.jpg')
})

// ---------------------------------------------------------------------------
// Page content: arrays, escaping, empty sections
// ---------------------------------------------------------------------------
test('benefits, how-to, FAQ and testimonials render from the stored arrays, escaped', () => {
  const html = rich()
  assert.ok(!html.includes('[object Object]'))
  assert.ok(html.includes('<strong>Benefit &lt;one&gt;</strong><span>Body &amp; more</span>'))
  assert.ok(html.includes('<use href="#icon-shield"></use>'))
  assert.ok(html.includes('<span aria-hidden="true">🌿</span>'), 'an emoji icon is allowed')
  assert.ok(html.includes('<li><strong>Cleanse:</strong> Wash your face.</li>'))
  assert.ok(html.includes('<li><strong>Apply:</strong> Use 3 drops.</li>'), 'a trailing colon is not doubled')
  assert.ok(html.includes('<details class="faq-item" open><summary>Is it safe?</summary><p>Yes, &lt;b&gt;very&lt;/b&gt;.</p></details>'))
  assert.ok(html.includes('<details class="faq-item"><summary>How fast?</summary>'))
  assert.ok(html.includes('<div class="testimonial-title">Amaka O. - Lagos</div>'))
  assert.ok(html.includes('Faded in 10 days &lt;3'))
  assert.ok(html.includes('src="https://media.example.com/uploads/t1.jpg"'))
})

test('empty lists drop their section instead of printing an empty heading', () => {
  const html = renderProduct({ ...baseSnapshot, testimonials: [], page: { ...baseSnapshot.page, benefits: [], howToUse: [], faq: [], summaryHtml: '' } }, { siteUrl: SITE })
  for (const id of ['benefits-title', 'how-to-use-title', 'faq-title', 'testimonials-title']) assert.ok(!html.includes(id), id)
  assert.ok(!html.includes('<p></p>'))
  assert.ok(html.includes('class="trust-row"'), 'default trust badges still render')
})

test('a value that looks like a template slot is data, not a slot', () => {
  const snap = { ...baseSnapshot, product: { ...baseSnapshot.product, description: 'Try {{CSS_INLINE}} and {{SVG_SPRITE}}' } }
  const html = renderProduct(snap, { css: 'body{color:red}', sprite: '<svg id="SPRITE"></svg>' })
  assert.ok(html.includes('Try {{CSS_INLINE}} and {{SVG_SPRITE}}'))
  assert.ok(!html.includes('id="SPRITE"') || html.split('id="SPRITE"').length === 2, 'the sprite appears once, from its own slot')
})

test('the build-provided parts (sprite, runtime config, scripts, turnstile key) reach the page', () => {
  const html = rich({ sprite: '<svg class="dm-defs" id="S"></svg>', runtimeConfig: '<script>window.API_BASE="";</script>', inlineScripts: '<script>var a=1</script>', turnstileSiteKey: '0xKEY' })
  assert.ok(html.includes('<svg class="dm-defs" id="S"></svg>'))
  assert.ok(html.includes('<script>window.API_BASE="";</script>'))
  assert.ok(html.includes('<script>var a=1</script>'))
  assert.ok(html.includes('data-sitekey="0xKEY"'))
  assert.ok(html.includes('<script src="/site.abcd.js" defer></script>'), 'the app script path is root-absolute, not relative to /slug/')
  assert.ok(html.includes('max="20"'))
})

// ---------------------------------------------------------------------------
// Drift guard: a published page must carry every hook the hand-written page has.
// The template used to be a stale copy (different field ids, no sticky header, no
// testimonials, no Turnstile container), so the form on a published page did not match the JS.
// ---------------------------------------------------------------------------
test('a published page has every id, data-* hook and layout class the hand-written product page has', () => {
  const source = readFileSync(new URL('../../dodumodu_site/products/glow-serum/index.html', import.meta.url), 'utf8')
  const strip = (h) => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const facts = (h) => ({
    ids: new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])),
    data: new Set([...h.matchAll(/\s(data-[a-z-]+)/g)].map((m) => m[1])),
    classes: new Set([...h.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))),
  })
  const sprite = source.match(/<svg class="dm-defs"[\s\S]*?(?=<a href="#order-form" class="skip-link">)/)[0]
  const want = facts(strip(source))
  const got = facts(strip(rich({ sprite, turnstileSiteKey: 'k' })))
  for (const kind of ['ids', 'data', 'classes']) {
    const missing = [...want[kind]].filter((x) => !got[kind].has(x))
    assert.deepEqual(missing, [], `published page is missing ${kind}: ${missing.join(', ')}`)
  }
})

test('a snapshot with no valid publish ref is refused, not rendered as pub_0 (which fails every deploy verification)', () => {
  const { publishRef, ...noRef } = baseSnapshot
  assert.throws(() => renderProduct(noRef, {}), /publishRef/)
  assert.throws(() => renderProduct({ ...baseSnapshot, publishRef: 'pub_12' }, {}), /publishRef/)
  assert.ok(renderProduct({ ...baseSnapshot, publishRef: 'pub_abcdef0123456789abcd' }, {}).includes('content="pub_abcdef0123456789abcd"'))
})
