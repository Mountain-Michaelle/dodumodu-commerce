import { Hono } from "hono";
const app = new Hono();
const PRODUCTS = { "glow-serum": { html: "<h1>P</h1>", etag: '"e1"', publishId: 7 } };
app.get("/", (c) => c.text("root"));
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const entry = PRODUCTS[slug ?? ""];
  if (!entry) return c.next();
  return c.html(entry.html, 200, { ETag: entry.etag });
});
app.get("/:slug/", async (c) => {
  const slug = c.req.param("slug");
  const entry = PRODUCTS[slug ?? ""];
  if (!entry) return c.next();
  return c.html(entry.html + "TRAILING", 200, { ETag: entry.etag });
});
app.get("/static/*", (c) => c.text("static:" + c.req.path));
app.get("*", (c) => c.text("wildcard:" + c.req.path));
for (const p of ["/", "/glow-serum", "/glow-serum/", "/site.abc.min.js", "/thank-you.html", "/assets/x.css", "/nope.png", "/static/x.css"]) {
  const r = await app.request("http://x" + p);
  console.log(p.padEnd(22), r.status, (await r.text()).slice(0, 40));
}
