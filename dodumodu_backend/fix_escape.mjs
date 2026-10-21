import fs from 'node:fs';
const p = 'build/render-product.mjs';
let s = fs.readFileSync(p, 'utf8');
const old = `    .replace(/[\\f]/g, '\\\\f')
}`;
const replacement = `    .replace(/[\\f]/g, '\\\\f')
    .replace(/</g, '\\\\u003c')
    .replace(/>/g, '\\\\u003e')
}`;
if (s.includes(old)) {
  s = s.replace(old, replacement);
  // Add comment before function
  s = s.replace('// ---- JSON string escaping (for JSON-LD string values) ----',
    '// ---- JSON string escaping (for JSON-LD string values) ----\n// Escapes < and > as \\u003c/\\u003e so the JSON-LD block inside a <script> tag\n// can never be terminated early by attacker-controlled text.');
  fs.writeFileSync(p, s);
  console.log('done');
} else {
  console.log('pattern not found');
}
