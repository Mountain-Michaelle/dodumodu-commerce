const fs=require("fs");
const src=fs.readFileSync("src/generated/site.ts","utf8");
console.log("exports:", [...src.matchAll(/^export const (\w+)/gm)].map(m=>m[1]).join(", "));
