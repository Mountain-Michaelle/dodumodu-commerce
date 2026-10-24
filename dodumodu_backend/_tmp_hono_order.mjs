import { Hono } from "hono";
const app = new Hono();
app.get("/:slug", (c) => c.text("PARAM:" + c.req.param("slug")));
app.get("*", (c) => c.text("STATIC"));
for (const p of ["/glow-serum/", "/glow-serum", "/assets/x.css"]) {
  const r = await app.request("http://x" + p);
  console.log(JSON.stringify(p), "->", r.status, await r.text());
}
