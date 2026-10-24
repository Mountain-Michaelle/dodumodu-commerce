import { readFileSync } from "node:fs";
const site = readFileSync("src/generated/site.ts","utf8");
const m = site.match(/PRODUCTS = (\{.*?\});/s);
console.log("workflow regex /PRODUCTS = (\\{.*?\\});/s matched:", !!m);
const m2 = site.match(/BUILD_ID = \"([^\"]+)\"/);
console.log("BUILD_ID regex matched:", !!m2, m2 && m2[1]);
console.log("semicolon after PRODUCTS?:", /export const PRODUCTS = .*;\n/.test(site.split("\n")[2] ?? ""));
const line = site.split("\n")[2] ?? "";
console.log("PRODUCTS line tail:", JSON.stringify(line.slice(-60)));
