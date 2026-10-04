// Ad-hoc: where do the bytes of the built page actually go?
//   node scripts/where-does-it-weigh.mjs
// Answers the "is it fast yet?" question with numbers per section instead of
// one total, so a regression points at the thing that caused it.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../dist/products/glow-serum/index.html", import.meta.url));
const html = readFileSync(file, "utf8");
// gzip of an empty buffer is ~20 bytes of header/footer, which would read as
// "this section costs something" when the page no longer ships it at all.
const gz = (s) => (s.length === 0 ? 0 : gzipSync(Buffer.from(s), { level: 9 }).length);
const row = (label, part) => console.log(
  `${label.padEnd(20)}${String(Buffer.byteLength(part)).padStart(8)} raw${String(gz(part)).padStart(8)} gzip`,
);

const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1];
const ld = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [, ""])[1];
const sprite = (html.match(/<svg[\s\S]*?<\/svg>/) || [, ""])[0];
const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0]).join("");
const markup = html
  .replace(/<style>[\s\S]*?<\/style>/, "")
  .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "")
  .replace(/<svg[\s\S]*?<\/svg>/, "")
  .replace(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/g, "");

row("inline <style>", style);
row("JSON-LD", ld);
row("icon sprite", sprite);
row("inline scripts", inline);
row("markup (rest)", markup);
console.log("-".repeat(36));
row("TOTAL", html);
