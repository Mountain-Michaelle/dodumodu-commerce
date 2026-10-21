import { Hono } from "hono";
const app = new Hono();
const known = new Set(["glow-serum"]);
app.get("/:slug", (c) => {
  const s = c.req.param("slug");
  const e = known.has(s);
  return c.body(null, e ? 200 : 404);
});
app.get("*", (c) => c.text("STAR"));
for (const p of ["/glow-serum","/glow-serum/","/site.050e8ce3.min.js","/thank-you.html","/assets/x.css","/nope.png"]) {
  const r = await app.request(p);
  console.log(p.padEnd(26),"->",r.status, JSON.stringify(await r.text()));
}
