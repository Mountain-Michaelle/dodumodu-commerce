import { Hono } from "hono";
const app = new Hono();
app.get("/:slug", (c) => c.text("SLUG:" + c.req.param("slug")));
app.get("*", (c) => c.text("STAR"));
for (const p of ["/glow-serum", "/site.050e8ce3.min.js", "/thank-you.html", "/assets/x.css", "/nope.png", "/a/b"]) {
  const res = await app.request(p);
  console.log(p.padEnd(26), "->", res.status, await res.text());
}
