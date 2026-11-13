import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderProduct, escapeHtml, escapeHtmlAttr, escapeJsonString, escapeUrl, validateSlug, formatPrice } from './render-product.mjs'

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
    benefits: '<li><strong>Benefit one</strong></li>',
    howToUse: '<li><strong>Step one</strong></li>',
    faq: '<details><summary>Q?</summary><p>A.</p></details>',
    whyLoveTitle: 'Why Love It',
    howToUseTitle: 'How to Use',
    ratingValue: '4.9',
    ratingCount: '1048',
    heroAlt: 'Serum bottle with dropper',
    ctaText: 'Place your order',
  },
  images: [{ r2Key: 'uploads/hero.jpg', altText: 'hero', width: 640, height: 640, variants: [] }],
  testimonials: [],
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
  assert.ok(html.includes('<p>Already safe <strong>rich</strong> text.</p>'))
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
  assert.ok(html.includes('"description": "A bright serum with \u003cscript\u003ealert(\\"xss\\")\u003c/script\u003e"'))
  assert.ok(html.includes('"@id": "/glow-serum/#product"'))
})
