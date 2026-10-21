import fs from 'node:fs';
const p = 'build/render-product.test.mjs';
let s = fs.readFileSync(p, 'utf8');

// Fix escaping test: replace the whole test block
const oldEscape = `test('renderProduct escapes untrusted product name in attributes', () => {
  const html = renderProduct(baseSnapshot, { css: '', jsPath: '/site.js' })
  assert.ok(html.includes('content="Radiance Glow Serum &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; - DODUMODU"'))
  assert.ok(!html.includes('<script>'))
})`;
const newEscape = `test('renderProduct escapes untrusted product description in attributes', () => {
  const html = renderProduct(baseSnapshot, { css: '', jsPath: '/site.js' })
  assert.ok(html.includes('name="description" content="A bright serum with &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"'))
  assert.ok(!html.includes('<script>'))
})`;
s = s.replace(oldEscape, newEscape);

// Fix JSON-LD test
const oldJson = `assert.ok(html.includes('"name": "Radiance Glow Serum &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"'))`;
const newJson = `assert.ok(html.includes('"description": "A bright serum with &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"'))`;
s = s.replace(oldJson, newJson);

fs.writeFileSync(p, s);
console.log('done');
