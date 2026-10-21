import { renderProduct } from './build/render-product.mjs'

const snap = {
  publishId: 7,
  slug: 'glow-serum',
  product: { id: 1, slug: 'glow-serum', name: 'Radiance Glow Serum', description: 'A serum.', price: 1500000 },
  page: { heroAlt: 'Bottle', ctaText: 'Place order', summaryHtml: '<p>hi</p>' },
  images: [{ r2Key: 'uploads/hero.jpg' }],
}
const html = renderProduct(snap, { css: '/*css*/', jsPath: '/site.abc.min.js', csp: "default-src 'none'" })

console.log('--- script tags in freshly rendered page ---')
for (const m of html.matchAll(/<script[^>]*>/g)) console.log(' ', m[0])
console.log('--- JSON-LD wrapped in a script tag? ---')
console.log('  has application/ld+json :', html.includes('application/ld+json'))
console.log('  has window.API_BASE     :', html.includes('window.API_BASE'))
console.log('  has IMAGE_DELIVERY_BASE :', html.includes('IMAGE_DELIVERY_BASE'))
console.log('--- first 300 chars of body ---')
const b = html.indexOf('<body')
console.log(JSON.stringify(html.slice(b, b + 300)))

