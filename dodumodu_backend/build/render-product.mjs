// build/render-product.mjs — the node-side entry: reads build/product.template.html and renders with it.
// All rendering lives in render-core.mjs (no file access) so the Worker can render a stored snapshot at request time.
import { readFileSync } from 'node:fs'
import { renderProductWith } from './render-core.mjs'
export * from './render-core.mjs'

const TEMPLATE = readFileSync(new URL('./product.template.html', import.meta.url), 'utf8')

export const productTemplate = () => TEMPLATE
export function renderProduct(snapshot, opts = {}) {
  return renderProductWith(TEMPLATE, snapshot, opts)
}
