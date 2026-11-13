import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { securityHeaders, htmlCsp } from "./securityHeaders";
import { ADMIN_CONSOLE_HTML, ADMIN_LOGIN_HTML } from "../generated/adminPages";
import { app as composed } from "../app";

const mini = (html?: string) => {
  const a = new Hono<{ Bindings: { ENVIRONMENT?: string } }>();
  a.use("*", securityHeaders() as never);
  a.get("/json", (c) => c.json({ ok: true }));
  a.get("/page", (c) => c.html(html ?? "<p>hi</p>"));
  a.get("/own", (c) => { c.header("X-Frame-Options", "SAMEORIGIN"); c.header("Content-Security-Policy", "default-src 'self'"); return c.text("x"); });
  return a;
};

test("every response carries the baseline browser protections", async () => {
  const r = await mini().request("/json", {}, { ENVIRONMENT: "production" });
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(r.headers.get("referrer-policy")!, /strict-origin/);
  assert.match(r.headers.get("permissions-policy")!, /camera=\(\)/);
  assert.match(r.headers.get("strict-transport-security")!, /max-age=31536000/);
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
});
test("HSTS is production-only, so a local http run is never pinned", async () => {
  const r = await mini().request("/json", {}, { ENVIRONMENT: "sandbox" });
  assert.equal(r.headers.get("strict-transport-security"), null);
});
test("a route that chose its own header keeps it", async () => {
  const r = await mini().request("/own", {}, { ENVIRONMENT: "production" });
  assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(r.headers.get("content-security-policy"), "default-src 'self'");
});
test("HTML gets a CSP whose script hashes are exactly the inline scripts it carries, with no blanket unsafe-inline for scripts", async () => {
  const inline = "window.__x = 1;";
  const hash = `'sha256-${createHash("sha256").update(inline).digest("base64")}'`;
  const r = await mini(`<html><body><script>${inline}</script><script src="/a.js"></script></body></html>`).request("/page", {}, { ENVIRONMENT: "production" });
  const csp = r.headers.get("content-security-policy")!;
  assert.ok(csp.includes(hash), csp);
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(csp.split(";").find((d) => d.trim().startsWith("script-src"))!, /unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /default-src 'none'/);
});
test("the real admin pages produce a CSP that allows their own inline script and nothing external", async () => {
  const console_ = await htmlCsp(ADMIN_CONSOLE_HTML);
  assert.match(console_, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(console_, /https?:\/\//, "no external origin is allowed");
  const login = await htmlCsp(ADMIN_LOGIN_HTML);
  assert.match(login, /script-src 'self'/); assert.doesNotMatch(login, /https?:\/\//);
});
test("the composed app sends the headers on a public API response and on a refusal", async () => {
  const kv = { get: async () => null, put: async () => {}, delete: async () => {} };
  const r = await composed.request("/reconcile-pending", { method: "POST" }, { ENVIRONMENT: "production", DATABASE_URL: "x", RATE_LIMIT_API_PER_MINUTE: "20", RATE_LIMIT_KV: kv } as never);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff"); assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(r.headers.get("strict-transport-security") ?? "", /max-age/);
});

test("a page that declares its own CSP (the storefront's <meta>) keeps it: no second header is stacked on top and it is not blanked", async () => {
  const page = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' https://media.example.com"></head><body>shop</body></html>`;
  const r = await mini(page).request("/page", {}, { ENVIRONMENT: "production" });
  assert.equal(r.headers.get("content-security-policy"), null, "no header CSP that would be ANDed with the page's own");
  assert.equal(await r.text(), page, "body untouched");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff", "the other protections still apply");
});

test("the real storefront pages keep their own meta CSP; the self-contained thank-you page gets the hashed header CSP", async () => {
  const env = { DATABASE_URL: "postgres://x", ENVIRONMENT: "production" } as never;
  for (const path of ["/"]) {
    const r = await composed.fetch(new Request(`https://shop.example.com${path}`), env);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("content-security-policy"), null, `${path} is governed by its own meta CSP`);
    assert.match(await r.text(), /http-equiv="Content-Security-Policy"/, `${path} carries the meta CSP`);
  }
  const ty = await composed.fetch(new Request("https://shop.example.com/thank-you.html"), env);
  assert.match(ty.headers.get("content-security-policy") ?? "", /script-src 'self' 'sha256-/, "thank-you has no CSP of its own, so it gets the hashed one");
});

test("admin pages may load product images from the configured media origin (and from nowhere else)", async () => {
  const csp = async (env: Record<string, string>) => (await mini("<html><body>x</body></html>").request("/page", {}, env)).headers.get("content-security-policy") ?? "";
  assert.match(await csp({ ENVIRONMENT: "production", IMAGE_DELIVERY_BASE: "https://media.example.com/files" }), /img-src 'self' data: blob: https:\/\/media\.example\.com(;|$)/);
  assert.match(await csp({ ENVIRONMENT: "production", IMAGE_DELIVERY_BASE: "/media" }), /img-src 'self' data: blob:(;|$)/, "same-origin media adds nothing");
  assert.match(await csp({ ENVIRONMENT: "production", IMAGE_DELIVERY_BASE: "http://insecure.example.com" }), /img-src 'self' data: blob:(;|$)/, "plain http is never allowed");
});
