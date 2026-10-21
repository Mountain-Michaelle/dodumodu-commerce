import { Hono } from "hono";
const app = new Hono();
app.get("/:slug", (c) => c.text("SLUG:" + c.req.param("slug")));
app.get("*", (c) => c.text("STAR"));
for (const p of ["/glow-serum", "/glow-serum/", "/glow-serum//"]) {
  const res = await app.request(p);
  console.log(JSON.stringify(p).padEnd(18), "->", res.status, await res.text());
}
