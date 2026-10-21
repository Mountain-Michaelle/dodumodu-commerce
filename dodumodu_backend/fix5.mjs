import fs from 'node:fs';
const p = 'build/render-product.test.mjs';
let s = fs.readFileSync(p, 'utf8');

// Fix test 1: description meta tag uses escapeHtmlAttr -> &lt; not \u003c
s = s.replace(
  'content="A bright serum with \\u003cscript\\u003ealert(\\u0026quot;xss\\u0026quot;)\\u003c/script\\u003e"',
  'content="A bright serum with &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"'
);

// Fix test 2: JSON-LD uses escapeJsonString -> \u003c not &lt;
s = s.replace(
  '"description": "A bright serum with &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"',
  '"description": "A bright serum with \\u003cscript\\u003ealert(\\\\"xss\\\\")\\u003c/script\\u003e"'
);

fs.writeFileSync(p, s);
console.log('done');
