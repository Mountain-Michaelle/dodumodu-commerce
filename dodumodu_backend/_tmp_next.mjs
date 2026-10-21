import { Hono } from "hono";
const app = new Hono();
const known = new Set(["glow-serum"]);
app.get("/:slug", async (c, next) => {
  const s = c.req.param("slug");
  if (!known.has(s)) return next();
  return c.text("SLUG:" + s);
});
app.get("/:slug/", async (c, next) => {
  const s = c.req.param("slug");
  if (!known.has(s)) return next();
  return c.text("SLUG2:" + s);
});
app.get("*", (c) => c.text("STAR"));
for (const p of ["/glow-serum","/glow-serum/","/site.050e8ce3.min.js","/thank-you.html","/assets/x.css","/nope.png","/products/"]) {
  const r = await app.request(p);
  console.log(p.padEnd(26),"->",r.status, await r.text());
}
