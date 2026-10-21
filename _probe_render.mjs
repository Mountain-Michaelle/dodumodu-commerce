import { renderProduct } from './dodumodu_backend/build/render-product.mjs'

const h = renderProduct(
  {
    publishId: 1,
    slug: 'glow-serum',
    product: { id: 1, slug: 'glow-serum', name: 'X', description: 'd', price: 100 },
    page: {},
    images: [],
  },
  { css: '', jsPath: '/site.js' },
)

console.log('has dm-defs svg:', h.includes('class="dm-defs"'))
console.log('has id="dm-logo":', h.includes('id="dm-logo"'))
console.log('has id="icon-truck":', h.includes('id="icon-truck"'))
console.log('references #dm-logo:', h.includes('href="#dm-logo"'))
console.log('references #icon-truck:', h.includes('href="#icon-truck"'))
console.log('SVG_SPRITE slot empty:', h.includes('{{SVG_SPRITE}}') === false)
console.log('len:', h.length)
