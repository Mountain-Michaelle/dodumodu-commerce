import { renderProduct } from './build/render-product.mjs';
const snap = { publishId: 7, slug: 'glow-serum', product: { id: 1, slug: 'glow-serum', name: 'Radiance Glow Serum', description: 'A bright serum with <script>alert("xss")</script>', price: 1500000 }, page: { heroAlt: 'Serum bottle', ctaText: 'Place order', summaryHtml: '<p>hi</p>' }, images: [{ r2Key: 'uploads/hero.jpg' }] };
const html = renderProduct(snap, { css: '', jsPath: '/site.js' });
// Check if unescaped <script> appears outside of template script tags
const scriptTags = [...html.matchAll(/<script[^>]*>/g)].map(m => m[0]);
console.log('Script tags found:', JSON.stringify(scriptTags));
// Check the description meta tag
const descMatch = html.match(/<meta name="description" content="([^"]*)"/);
console.log('Description meta:', descMatch ? descMatch[1] : 'NOT FOUND');
// Check JSON-LD description
const jsonLdMatch = html.match(/"description": "([^"]*)"/);
console.log('JSON-LD description:', jsonLdMatch ? jsonLdMatch[1] : 'NOT FOUND');
