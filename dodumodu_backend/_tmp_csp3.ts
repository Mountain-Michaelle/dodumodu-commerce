import { createHash } from "node:crypto";
import * as site from "./src/generated/site.ts";
const sha=(s:string)=>createHash("sha256").update(s).digest("base64");
const cspH=[...site.CSP.matchAll(/sha256-([A-Za-z0-9+/=]+)/g)].map(m=>m[1]);
const grab=(h:string,tag:string)=>[...h.matchAll(new RegExp("<"+tag+"(?![^>]*\\\\bsrc=)[^>]*>([\\\\s\\\\S]*?)</"+tag+">","g"))].map(m=>m[1]);
for (const [name,html] of [["INDEX_HTML",site.INDEX_HTML],["PRODUCTS[glow-serum]",(site as any).PRODUCTS["glow-serum"].html]] as const) {
  const s=grab(html,"script"), st=grab(html,"style");
  console.log("=== "+name+" ===");
  console.log("  inline scripts:",s.length,"styles:",st.length);
  console.log("  script hashes all in CSP?", s.every(x=>cspH.includes(sha(x))));
  console.log("  style  hashes all in CSP?", st.every(x=>cspH.includes(sha(x))));
  console.log("  script src:", html.match(/<script[^>]*src="([^"]+)"/)?.[1]);
  console.log("  has ld+json script:", /<script[^>]*application\/ld\+json/.test(html));
  console.log("  body head:", JSON.stringify(html.slice(html.indexOf("<body"),html.indexOf("<body")+90)));
}
