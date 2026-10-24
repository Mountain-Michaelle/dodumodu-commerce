import fs from 'node:fs';
const p = 'build/render-product.test.mjs';
let s = fs.readFileSync(p, 'utf8');

// Fix test 1: replace the bad <script> check with a check for unescaped alert(
s = s.replace(
  "  assert.ok(!html.includes('<script>'))",
  "  assert.ok(!html.includes('alert('))"
);

// Fix test 2: JSON-LD now uses \u003c escapes, not &lt;
s = s.replace(
  '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
  '\\u003cscript\\u003ealert(\\u0026quot;xss\\u0026quot;)\\u003c/script\\u003e'
);

fs.writeFileSync(p, s);
console.log('done');
