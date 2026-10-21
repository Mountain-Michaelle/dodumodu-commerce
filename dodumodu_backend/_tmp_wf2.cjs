const fs=require("fs");
const src=fs.readFileSync("src/generated/site.ts","utf8");
const m=src.match(/PRODUCTS = (\{.*?\});/s);
console.log("regex matched:", !!m);
console.log("has BUILD_ID export:", /^export const BUILD_ID/m.test(src));
console.log("has PRODUCTS export:", /^export const PRODUCTS/m.test(src));
const b=src.match(/BUILD_ID = "([^"]+)"/);
console.log("BUILD_ID capture:", b && b[1]);
