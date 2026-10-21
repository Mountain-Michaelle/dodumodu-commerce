import fs from 'node:fs';
const p = 'build/render-product.mjs';
let s = fs.readFileSync(p, 'utf8');
// Find the closing of escapeJsonString and add < > escaping before it
const marker = "    .replace(/[\\f]/g, '\\\\f')\n}";
if (s.includes(marker)) {
  s = s.replace(marker, "    .replace(/[\\f]/g, '\\\\f')\n    .replace(/</g, '\\u003c')\n    .replace(/>/g, '\\u003e')\n}");
  // Add comment
  s = s.replace('// ---- JSON string escaping (for JSON-LD string values) ----',
    '// ---- JSON string escaping (for JSON-LD string values) ----\n// Escapes < and > as \\u003c/\\u003e so JSON-LD inside <script> cannot be terminated early.');
  fs.writeFileSync(p, s);
  console.log('done');
} else {
  console.log('marker not found');
  // Debug: show lines around escapeJsonString end
  const lines = s.split('\n');
  for (let i = 38; i <= 42; i++) console.log(i, JSON.stringify(lines[i]));
}
