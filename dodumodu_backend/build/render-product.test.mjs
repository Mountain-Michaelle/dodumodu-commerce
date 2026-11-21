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
    sectionTitles: {
      benefits: 'Why people love it',
      testimonials: 'Customer feedback',
      whatsapp: 'Customer WhatsApp messages',
      howToUse: 'How to apply',
      faq: 'Questions & answers',
      middleCta: 'Ready to order?',
      order: 'Place your order',
      finalCta: 'Still thinking?',
    },
    ratingValue: '4.9',
    ratingCount: '1048',
    heroAlt: 'Serum bottle with dropper',
    ctaText: 'Place your order',
  },
  images: [{ r2Key: 'uploads/hero.jpg', altText: 'hero', width: 640, height: 640, variants: [] }],
  testimonials: [{ r2Key: 'uploads/t1.jpg', title: 'Amaka O. - Lagos', description: 'Faded in 10 days <3', kind: 'review' }, { r2Key: 'uploads/w1.jpg', title: 'Shot', description: '', kind: 'whatsapp', width: 540, height: 960 }],
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

test('the static hero is the optimised image the carousel requests first, preloaded with the same srcset', () => {
  const html = rich()
  const o = 'https://media.example.com/cdn-cgi/image/'
  assert.ok(html.includes(`<div class="carousel-slide"><img src="${o}width=640,quality=75,format=auto,fit=scale-down/uploads/hero.jpg"`))
  assert.ok(html.includes(`${o}width=320,quality=75,format=auto,fit=scale-down/uploads/hero.jpg 320w`))
  assert.ok(html.includes('alt="Serum bottle with dropper"'))
  assert.match(html, /<link rel="preload" as="image" href="[^"]*width=640[^"]*" imagesrcset="[^"]*320w[^"]*960w" imagesizes="[^"]+" fetchpriority="high">/)
  assert.ok(html.includes('<link rel="preconnect" href="https://media.example.com">'))
  assert.ok(!html.includes('picsum.photos'), 'no placeholder host baked into a real page')
  assert.ok(!html.includes('image/webp'), 'the preload no longer claims a type the file does not have')
  // same origin as the site: nothing to preconnect to
  assert.ok(!rich({ deliveryBase: '/media' }).includes('rel="preconnect"'))
  // derivative mode points at the pre-sized files instead of the edge resizer
  assert.ok(rich({ imageMode: 'derivative' }).includes('uploads/hero.w640.jpg'))
})

test('without a custom domain (same-origin /media or workers.dev) photos are the plain file, never a /cdn-cgi URL that 404s', () => {
  for (const deliveryBase of ['/media', 'https://dodumodu.example.workers.dev/media']) {
    const html = rich({ deliveryBase })
    assert.ok(!html.includes('cdn-cgi'), deliveryBase)
    assert.ok(html.includes(`uploads/hero.jpg"`), deliveryBase)
    assert.ok(!html.includes('<img src="" '), deliveryBase)
    assert.ok(!/<div class="carousel-slide"><img[^>]* srcset=/.test(html), 'no srcset of identical URLs')
  }
})

test('the whole gallery is printed as the finished carousel track, so the script never has to rebuild (or blank) the hero', () => {
  const two = { ...baseSnapshot, images: [{ r2Key: 'uploads/hero.jpg', altText: 'Serum bottle with dropper' }, { r2Key: 'uploads/two.jpg', altText: 'Second' }, { r2Key: 'uploads/three.jpg', altText: '' }] }
  const html = renderProduct(two, { siteUrl: SITE, deliveryBase: 'https://media.example.com' })
  const track = html.match(/<div id="carousel">\s*<div class="carousel-wrap"><div class="carousel" role="region" aria-roledescription="carousel" aria-label="Product photos" tabindex="0">(.*?)<\/div><\/div>\s*<\/div>/s)
  assert.ok(track, 'a finished track sits inside #carousel')
  const slides = track[1].split('<div class="carousel-slide">').slice(1)
  assert.equal(slides.length, 3)
  assert.match(slides[0], /fetchpriority="high"/); assert.ok(!/loading="lazy"/.test(slides[0]), 'the first photo is never lazy')
  assert.ok(slides.slice(1).every((x) => /loading="lazy"/.test(x) && /decoding="async"/.test(x) && /width="960" height="960"/.test(x)))
  assert.ok(slides[1].includes('uploads/two.jpg') && slides[1].includes('alt="Second"') && slides[2].includes('alt=""'))
  assert.ok(!html.includes('data-gallery'), 'no second copy of the gallery as JSON')
  assert.ok(!renderProduct({ ...baseSnapshot, images: [] }, { siteUrl: SITE }).includes('class="carousel"'))
})

test('an empty hero alt falls back to the product name (an empty string used to win)', () => {
  const html = renderProduct({ ...baseSnapshot, page: { ...baseSnapshot.page, heroAlt: '' } }, { siteUrl: SITE })
  assert.ok(html.includes('alt="Radiance Glow Serum"'))
})

test('a product with no images renders without a hero, preload or og:image', () => {
  const html = renderProduct({ ...baseSnapshot, images: [] }, { siteUrl: SITE })
  assert.ok(!html.includes('og:image'))
  assert.ok(!html.includes('rel="preload"'))
  assert.ok(!html.includes('carousel-slide'))
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
  assert.ok(html.includes('<p class="testimonial-title">Amaka O. - Lagos</p>'))
  assert.ok(html.includes('Faded in 10 days &lt;3'))
  assert.match(html, /<img class="testimonial-image" src="https:\/\/media\.example\.com\/cdn-cgi\/image\/width=640,quality=70[^"]*\/uploads\/t1\.jpg"/, 'the review photo is the resized, lazy image')
})

test('empty lists drop their section instead of printing an empty heading', () => {
  const html = renderProduct({ ...baseSnapshot, testimonials: [], page: { ...baseSnapshot.page, benefits: [], howToUse: [], faq: [], summaryHtml: '' } }, { siteUrl: SITE })
  for (const id of ['benefits-title', 'how-to-use-title', 'faq-title', 'testimonials-title']) assert.ok(!html.includes(id), id)
  assert.ok(!html.includes('<p></p>'))
  assert.ok(html.includes('class="trust-row"'), 'default trust badges still render')
})

// ---------------------------------------------------------------------------
// Section headings: all eight resolve from page.sectionTitles
// ---------------------------------------------------------------------------
test('all eight section headings render from custom sectionTitles values', () => {
  const html = rich()
  assert.ok(html.includes('<h2 id="benefits-title">Why people love it</h2>'), 'benefits')
  assert.ok(html.includes('<h2 id="testimonials-title">Customer feedback</h2>'), 'testimonials')
  assert.ok(html.includes('<h2 id="whatsapp-title">Customer WhatsApp messages</h2>'), 'whatsapp')
  assert.ok(html.includes('<h2 id="how-to-use-title">How to apply</h2>'), 'howToUse')
  assert.ok(html.includes('<h2 id="faq-title">Questions &amp; answers</h2>'), 'faq')
  assert.ok(html.includes('<h2 id="cta-mid-title">Ready to order?</h2>'), 'middleCta')
  assert.ok(html.includes('<h2 id="order-title">Place your order</h2>'), 'order')
  assert.ok(html.includes('<h2 id="cta-end-title">Still thinking?</h2>'), 'finalCta')
})

test('section headings escape HTML-sensitive input', () => {
  const html = renderProduct({ ...baseSnapshot, page: { ...baseSnapshot.page, sectionTitles: { ...baseSnapshot.page.sectionTitles, benefits: '<script>alert("x")</script>' } } }, { siteUrl: SITE })
  assert.ok(html.includes('<h2 id="benefits-title">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h2>'))
  assert.ok(!html.includes('<script>'))
})

test('missing, null, and blank heading values fall back to the default wording', () => {
  const page = {
    ...baseSnapshot.page,
    sectionTitles: {
      benefits: '',
      testimonials: null,
      whatsapp: '   ',
      howToUse: undefined,
      faq: 'Custom FAQ',
      middleCta: null,
      order: '',
      finalCta: 'Custom final',
    },
  }
  const html = renderProduct({ ...baseSnapshot, page }, { siteUrl: SITE })
  assert.ok(html.includes('<h2 id="benefits-title">Why Nigerian Women Love This Serum</h2>'), 'benefits blank -> default')
  assert.ok(html.includes('<h2 id="testimonials-title">What customers say</h2>'), 'testimonials null -> default')
  assert.ok(html.includes('<h2 id="whatsapp-title">Real WhatsApp messages from customers</h2>'), 'whatsapp blank -> default')
  assert.ok(html.includes('<h2 id="how-to-use-title">How To Use For Best Results</h2>'), 'howToUse undefined -> default')
  assert.ok(html.includes('<h2 id="faq-title">Custom FAQ</h2>'), 'faq custom kept')
  assert.ok(html.includes('<h2 id="cta-mid-title">Ready to place your order?</h2>'), 'middleCta null -> default')
  assert.ok(html.includes('<h2 id="order-title">Place your order now</h2>'), 'order blank -> default')
  assert.ok(html.includes('<h2 id="cta-end-title">Custom final</h2>'), 'finalCta custom kept')
})

test('section with no content omits its heading too', () => {
  const html = renderProduct({ ...baseSnapshot, testimonials: [], page: { ...baseSnapshot.page, benefits: [], howToUse: [], faq: [] } }, { siteUrl: SITE })
  assert.ok(!html.includes('benefits-title'), 'empty benefits section has no heading')
  assert.ok(!html.includes('how-to-use-title'), 'empty how-to section has no heading')
  assert.ok(!html.includes('faq-title'), 'empty faq section has no heading')
  assert.ok(!html.includes('testimonials-title'), 'empty testimonials section has no heading')
  assert.ok(!html.includes('whatsapp-title'), 'no whatsapp screenshots -> no heading')
  assert.ok(html.includes('cta-mid-title'), 'middle CTA heading still renders')
  assert.ok(html.includes('order-title'), 'order heading still renders')
  assert.ok(html.includes('cta-end-title'), 'final CTA heading still renders')
})

test('section order and CTA placement remain unchanged', () => {
  const html = rich()
  const positions = {
    benefits: html.indexOf('id="benefits-title"'),
    testimonials: html.indexOf('id="testimonials-title"'),
    whatsapp: html.indexOf('id="whatsapp-title"'),
    howToUse: html.indexOf('id="how-to-use-title"'),
    faq: html.indexOf('id="faq-title"'),
    middleCta: html.indexOf('id="cta-mid-title"'),
    order: html.indexOf('id="order-title"'),
    finalCta: html.indexOf('id="cta-end-title"'),
  }
  const ordered = Object.entries(positions)
    .filter(([, p]) => p >= 0)
    .sort(([, a], [, b]) => a - b)
    .map(([k]) => k)
  assert.deepEqual(ordered, ['benefits', 'testimonials', 'middleCta', 'whatsapp', 'howToUse', 'order', 'faq', 'finalCta'], 'headings appear in template section order')
  assert.ok(positions.testimonials > positions.benefits, 'testimonials after benefits')
  assert.ok(positions.middleCta > positions.testimonials, 'middle CTA after testimonials')
  assert.ok(positions.whatsapp > positions.middleCta, 'whatsapp after middle CTA')
  assert.ok(positions.howToUse > positions.whatsapp, 'how-to after whatsapp')
  assert.ok(positions.order > positions.howToUse, 'order form after how-to')
  assert.ok(positions.faq > positions.order, 'FAQ after order form')
  assert.ok(positions.finalCta > positions.faq, 'final CTA after FAQ')
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

// ---------------------------------------------------------------------------
// Static completeness: a published page needs no backend request to render or hydrate
// ---------------------------------------------------------------------------
const pageData = (html) => {
  const m = html.match(/<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/)
  assert.ok(m, 'embedded page-data script present')
  assert.ok(!m[1].includes('<'), 'no raw < inside page-data')
  return JSON.parse(m[1])
}

test('page-data is embedded, parseable, and survives hostile text and JS line separators', () => {
  const snap = {
    ...baseSnapshot,
    product: { ...baseSnapshot.product, name: 'A</script><b>x y z' },
    discountTiers: [{ minQuantity: 2, discountPercent: 5, label: '2+' }],
    paymentRules: { codStates: ['Lagos'], codBulkThreshold: 3 },
  }
  const html = renderProduct(snap, { css: '', jsPath: '/site.js' })
  const d = pageData(html)
  assert.equal(d.product.name, 'A</script><b>x y z')
  assert.equal(d.discountTiers.length, 1)
  assert.equal(d.maxOrderQuantity, 20)
  assert.deepEqual(d.paymentRules, { codStates: ['Lagos'], codBulkThreshold: 3 })
  assert.deepEqual(d.deliveryOptions, ['today', 'tomorrow', 'next_tomorrow'])
  assert.ok(!html.match(/\{\{[A-Z_]+\}\}/))
})

test('every testimonial is in the static markup, not just the first few', () => {
  const testimonials = Array.from({ length: 9 }, (_, i) => ({ r2Key: i % 2 ? `uploads/t${i}.jpg` : null, title: `Customer ${i}`, description: `Said ${i}`, kind: 'review' }))
  const html = renderProduct({ ...baseSnapshot, testimonials }, { css: '', jsPath: '/site.js', deliveryBase: 'https://media.example.com' })
  for (let i = 0; i < 9; i++) assert.ok(html.includes(`Customer ${i}`), `testimonial ${i} rendered`)
  assert.equal(pageData(html).testimonials.length, 9)
})

test('no testimonials renders no empty testimonial section', () => {
  const html = renderProduct({ ...baseSnapshot, testimonials: [] }, { css: '', jsPath: '/site.js' })
  assert.ok(!html.includes('testimonial-image') && !html.includes('testimonial-avatar'))
  assert.deepEqual(pageData(html).testimonials, [])
})

test('the same snapshot renders byte-identically (no clock or random input at render time)', () => {
  const a = renderProduct(baseSnapshot, { css: '', jsPath: '/site.js', buildId: 'b1' })
  const b = renderProduct(baseSnapshot, { css: '', jsPath: '/site.js', buildId: 'b1' })
  assert.equal(a, b)
})

test('written reviews and WhatsApp screenshots are two sections: screenshots are image-only, lazy, responsive, after the reviews', () => {
  const testimonials = [
    { r2Key: 'uploads/p.jpg', title: 'Photo', description: 'photo text', kind: 'review' },
    { r2Key: null, title: 'Plain', description: 'plain text', kind: 'review' },
    { r2Key: 'uploads/s.png', title: 'Shot', description: '', kind: 'whatsapp', width: 540, height: 960 },
    { r2Key: 'uploads/s2.png', title: 'NoDims', description: '', kind: 'whatsapp' },
  ]
  const o = { css: '', jsPath: '/site.js', deliveryBase: 'https://media.example.com' }
  const html = renderProduct({ ...baseSnapshot, testimonials }, o)
  // review section: photo card + initial tile, and NO screenshot inside it
  const rev = html.match(/<section class="section" aria-labelledby="testimonials-title">(.*?)<\/section>/s)[1]
  assert.match(rev, /testimonial-card has-photo"><img class="testimonial-image" src="https:\/\/media\.example\.com\/cdn-cgi\/image\/[^"]*uploads\/p\.jpg"/)
  assert.match(rev, /testimonial-card"><span class="testimonial-avatar"[^>]*>P<\/span>/)
  assert.ok(!rev.includes('testimonial-screenshot') && !rev.includes('is-screenshot'))
  // screenshot section: own H2, after the reviews, images only
  const iRev = html.indexOf('id="testimonials-title"'), iCta = html.indexOf('id="cta-mid-title"'), iShot = html.indexOf('id="whatsapp-title"')
  assert.ok(iRev > 0 && iCta > iRev && iShot > iCta, 'written reviews, then CTA, then WhatsApp screenshots')
  const sec = html.match(/<section class="section" aria-labelledby="whatsapp-title"><h2 id="whatsapp-title">([^<]+)<\/h2><div class="screenshot-grid">(.*?)<\/div><\/section>/s)
  assert.ok(sec, 'an H2 titled section like the others')
  assert.ok(!/<p|testimonial-body|testimonial-description/.test(sec[2]), 'no written text in the screenshot section')
  const imgs = sec[2].match(/<img [^>]*>/g)
  assert.equal(imgs.length, 2)
  for (const img of imgs) {
    assert.match(img, /loading="lazy"/); assert.match(img, /decoding="async"/); assert.match(img, /fetchpriority="low"/)
    assert.match(img, /srcset="[^"]*320w[^"]*640w"/); assert.match(img, /sizes="\(max-width: 768px\) 92vw, 300px"/)
    assert.match(img, /alt="WhatsApp message from (Shot|NoDims)"/)
  }
  assert.match(imgs[0], /width="540" height="960"/); assert.ok(!/ width=/.test(imgs[1]), 'no invented dimensions')
  // only screenshots: no review section at all; only reviews: no screenshot section
  const onlyShots = renderProduct({ ...baseSnapshot, testimonials: testimonials.slice(2) }, o)
  assert.ok(!onlyShots.includes('testimonials-title') && onlyShots.includes('whatsapp-title'))
  const onlyReviews = renderProduct({ ...baseSnapshot, testimonials: testimonials.slice(0, 2) }, o)
  assert.ok(onlyReviews.includes('testimonials-title') && !onlyReviews.includes('whatsapp-title'))
  // a screenshot row whose image is missing prints nothing (no broken frame, no empty section)
  const broken = renderProduct({ ...baseSnapshot, testimonials: [{ r2Key: '', title: 'X', description: '', kind: 'whatsapp' }] }, o)
  assert.ok(!broken.includes('whatsapp-title') && !broken.includes('testimonial-screenshot'))
  // lazy review photo too
  assert.match(rev, /class="testimonial-image"[^>]*loading="lazy"[^>]*decoding="async"/)
})
