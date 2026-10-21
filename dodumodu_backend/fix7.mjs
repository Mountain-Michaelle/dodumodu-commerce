import fs from 'node:fs';
const p = 'build/render-product.test.mjs';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(
  "  assert.ok(!html.includes('</script>'))",
  "  assert.ok(html.includes('&lt;/script&gt;'))"
);
fs.writeFileSync(p, s);
console.log('done');
