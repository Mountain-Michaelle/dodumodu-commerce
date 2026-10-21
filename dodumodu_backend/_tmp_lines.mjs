import { readFileSync } from "node:fs";
const site = readFileSync("src/generated/site.ts","utf8");
const lines = site.split("\n");
console.log("total lines:", lines.length);
lines.forEach((l,i)=>console.log(i, "len", l.length, "::", l.slice(0,70)));
