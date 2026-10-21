import { readFileSync } from "node:fs";
const tpl = readFileSync("build/product.template.html","utf8");
const dist = readFileSync("../dodumodu_site/dist/products/glow-serum/index.html","utf8");
const grab = (h) => [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const a = grab(tpl), b = grab(dist);
console.log("template inline scripts:", a.length, "dist inline scripts:", b.length);
for (let i=0;i<Math.max(a.length,b.length);i++){
  const same = a[i] === b[i];
  console.log(i, "identical:", same, "len tpl:", (a[i]||"").length, "len dist:", (b[i]||"").length);
}
console.log("tpl has ld+json script:", /<script[^>]*application\/ld\+json/.test(tpl));
console.log("dist has ld+json script:", /<script[^>]*application\/ld\+json/.test(dist));
