import { readFileSync } from 'node:fs'

const tpl = readFileSync('dodumodu_backend/build/product.template.html', 'utf8')
const staticPage = readFileSync('dodumodu_site/products/glow-serum/index.html', 'utf8')
const sprite = readFileSync('dodumodu_site/shared/icons/sprite.svg', 'utf8')

const refs = (h) => [...new Set([...h.matchAll(/<use[^>]*href="([^"]+)"/g)].map((m) => m[1]))]
const ids = (h) => [...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])

console.log('TPL use refs   :', JSON.stringify(refs(tpl)))
console.log('STATIC use refs:', JSON.stringify(refs(staticPage)))
console.log('SPRITE ids     :', JSON.stringify(ids(sprite)))
console.log('STATIC ids     :', JSON.stringify(ids(staticPage)))
console.log('TPL has ICONS marker:', tpl.includes('<!-- ICONS -->'))
console.log('STATIC has ICONS marker:', staticPage.includes('<!-- ICONS -->'))

const i = staticPage.indexOf('id="dm-logo"')
console.log('--- static dm-logo symbol ---')
console.log(staticPage.slice(i - 120, i + 900))
