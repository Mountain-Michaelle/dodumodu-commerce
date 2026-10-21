import { readFileSync } from "node:fs";
const dist = readFileSync("../dodumodu_site/dist/products/glow-serum/index.html","utf8");
const grab = (h) => [...h.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
for (const m of grab(dist)) console.log(JSON.stringify(m[1]), "len", m[2].length, "::", m[2].slice(0,80).replace(/\n/g," "));
