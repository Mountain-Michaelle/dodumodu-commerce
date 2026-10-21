import fs from 'node:fs';
const p = 'build/render-product.mjs';
let s = fs.readFileSync(p, 'utf8');
// Simple line-by-line approach
const lines = s.split('\n');
// Find line index of the closing } of escapeJsonString (line 40, 0-indexed 39)
// Insert < > escaping before it
const insertAt = 40; // 0-indexed line 40 is the }
lines.splice(insertAt, 0, "    .replace(/</g, '\\u003c')", "    .replace(/>/g, '\\u003e')");
// Add comment before function declaration (line 30, 0-indexed 29)
lines.splice(29, 0, '// Escapes < and > as \\u003c/\\u003e so JSON-LD inside <script> cannot be terminated early.');
s = lines.join('\n');
fs.writeFileSync(p, s);
console.log('done');
