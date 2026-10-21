import { Hono } from "hono";
const app = new Hono();
app.get("/:slug", (c) => c.text("SLUG:" + c.req.param("slug")));
app.get("*", (c) => c.text("STAR"));
for (const p of ["/glow-serum", "/glow-serum/", "/a/b", "/site.050e8ce3.min.js"]) {
  const r = await app.request("http://x" + p);
  console.log(JSON.stringify(p).padEnd(24), r.status, await r.text());
}
