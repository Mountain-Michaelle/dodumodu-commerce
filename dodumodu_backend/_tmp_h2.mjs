import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.text("root"));
app.get("/:slug", async (c, next) => {
  if (c.req.param("slug") === "glow-serum") return c.text("PRODUCT");
  return next();
});
app.get("*", (c) => c.text("static:" + c.req.path));
for (const p of ["/", "/glow-serum", "/site.abc.min.js", "/thank-you.html", "/assets/x.css", "/nope.png"]) {
  const r = await app.request("http://x" + p);
  console.log(p.padEnd(22), r.status, (await r.text()).slice(0, 40));
}
