import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { app as composed } from "../app";
import { q, sql } from "../auth/sql";
import { openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow } from "../auth/mfa-test-kit";
const NS = "/4ehhi-5deggi", ORIGIN = "https://shop.example.com";
const db = openTestDb(); const s = testSecrets(); const tag = makeTag("rbc");
const env = { DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "production", ADMIN_BASE_PATH: NS, ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
  RATE_LIMIT_ADMIN_PER_MINUTE: "100000", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "100000", RATE_LIMIT_KV: { get: async () => null, put: async () => undefined } } as never;
let opened: any = null;
after(async () => { await opened?.close().catch(() => undefined); await cleanupTag(db, tag); await closePools(); });
const NET = 1 + Math.floor(Math.random() * 200); let n = 0; const ip = () => `10.${NET}.66.${(n++ % 250) + 1}`;
declare const document: any; declare const location: any;
const call = (method: string, path: string, cookie?: string, body?: BodyInit | null) => { const a = ip();
  return composed.fetch(new Request(`${ORIGIN}${path}`, { method, redirect: "manual", headers: { host: "shop.example.com", origin: ORIGIN, "cf-connecting-ip": a, "x-test-ip": a, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: method === "GET" ? undefined : (body ?? "{}") }), env); };
let productId = 0;
async function session(label: string, role: "admin" | "mono", grants: string[]) {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role: "admin" });
  await q(db, sql`UPDATE aa_users SET role = ${role}, is_superuser = ${role === "admin"}, is_staff = true, device_window_until = now() + interval '1 hour' WHERE id = ${u.id}::uuid`);
  for (const g of grants) await q(db, sql`INSERT INTO aa_user_permissions (user_id, perm) VALUES (${u.id}::uuid, ${g})`);
  const vid = newVid(); const f = await newTotpFlow(db, s, u, { vid, stage: "ready" });
  const r = await call("POST", `${NS}/auth/session`, `__Host-aaf=${f.token}; __Host-vid=${vid}`);
  const sc = r.headers.get("set-cookie") ?? ""; const did = /__Host-did=([^;]+)/.exec(sc)?.[1];
  return { email: u.email, cookie: `__Host-sid=${/__Host-sid=([^;]+)/.exec(sc)![1]}${did ? `; __Host-did=${did}` : ""}; __Host-vid=${vid}` };
}
async function openConsole(pw: any, cookie: string) {
  const browser = opened = await pw.chromium.launch({ args: ["--no-proxy-server"] }); const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.route("**/*", async (route: any) => { const rq = route.request(); const url = new URL(rq.url());
    const res = await call(rq.method(), url.pathname + url.search, cookie, rq.postData() ?? undefined);
    return route.fulfill({ status: res.status, headers: Object.fromEntries([...(res.headers as any)] as [string, string][]), body: Buffer.from(await res.arrayBuffer()) }); });
  const page = await ctx.newPage(); const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e)));
  await page.goto(`${ORIGIN}${NS}/`); await page.waitForTimeout(1500);
  return { browser, page, errs,
    go: async (sec: string) => { await page.evaluate((h: string) => { location.hash = "#" + h; }, sec); await page.waitForTimeout(1500); },
    buttons: () => page.evaluate(() => Array.from(document.querySelectorAll("button")).map((e: any) => (e.textContent || "").trim())),
    nav: () => page.evaluate(() => Array.from(document.querySelectorAll(".sidebar-nav a, .sidebar-nav button")).map((e: any) => (e.textContent || "").trim())),
    route: () => page.evaluate(() => location.hash) };
}
async function dropProduct() {
  if (!productId) return;
  await q(db, sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE product_id = ${productId})`);
  await q(db, sql`DELETE FROM orders WHERE product_id = ${productId}`); await q(db, sql`DELETE FROM products WHERE id = ${productId}`);
}
test("admin console: sections are containers per user, and Orders has a working '+ New order' modal", async (t) => {
  t.after(dropProduct);
  const root = execSync("npm root -g", { encoding: "utf8" }).trim(); const pw = createRequire(`${root}/`)("playwright");
  productId = (await q<{ id: number }>(db, sql`INSERT INTO products (slug, name, description, price, package_options) VALUES (${`${tag}-p`}, 'Modal fixture', 'x', 1500000, '[{"id":"duo","label":"Duo","price":2800000}]') RETURNING id`))[0].id;
  const admin = await session("admin", "admin", []);
  const mono = await session("mono", "mono", ["orders.view", "orders.add"]);
  const noAdd = await session("noadd", "mono", ["orders.view"]);

  // --- a mono operator granted only Orders: the console shows only Orders, and "+ New order"
  let c = await openConsole(pw, mono.cookie);
  const nav = await c.nav();
  assert.ok(nav.some((t: string) => /Orders/.test(t)), `Orders listed: ${nav}`);
  for (const hidden of ["Products", "Media", "Categories", "Testimonials", "Blocked", "Discount tiers", "Payment rules", "Users", "Auth log", "Reports"])
    assert.ok(!nav.some((t: string) => t.startsWith(hidden)), `${hidden} must not be listed for this user: ${nav}`);
  await c.go("products"); assert.equal(await c.route(), "#orders", "opening a section by URL falls back to one they may use");
  await c.go("orders"); assert.ok((await c.buttons()).includes("+ New order"));
  await c.browser.close();

  // --- reports for a mono operator
  const rep = await session("rep", "mono", ["orders.view", "reports.view"]);
  c = await openConsole(pw, rep.cookie); await c.go("reports");
  const text = await c.page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  assert.match(text, /non-spam orders\s*0/i, "a mono operator with no assigned orders sees an empty personal report, not the business-wide one");
  assert.deepEqual(c.errs, []);
  await c.browser.close();

  // --- the same role without orders.add has no button
  c = await openConsole(pw, noAdd.cookie); await c.go("orders");
  assert.ok(!(await c.buttons()).includes("+ New order"), "no orders.add, no button");
  await c.browser.close();

  // --- an administrator: every section is there, and the modal creates an order
  c = await openConsole(pw, admin.cookie);
  const anav = await c.nav();
  for (const t of ["Orders", "Products", "Media", "Blocked", "Discount tiers", "Payment rules", "Users", "Auth log"]) assert.ok(anav.some((x: string) => x.startsWith(t)), `admin sees ${t}: ${anav}`);
  await c.go("orders");
  const btnBox = await c.page.locator("#aa-new-order").boundingBox();
  assert.ok(btnBox && btnBox.x > 900, `button sits at the top right (x=${btnBox?.x})`);
  await c.page.click("#aa-new-order"); await c.page.waitForSelector("#aa-new-order-modal form");
  await c.page.click('#aa-new-order-modal button[type="submit"]');
  await c.page.waitForTimeout(800);
  assert.ok((await c.page.locator("#aa-new-order-modal .field-error:not(:empty)").count()) >= 4, "empty form shows field errors and stays open");
  const sel = (n: string, v: string) => c.page.selectOption(`#aa-new-order-modal [name="${n}"]`, v);
  const fill = (n: string, v: string) => c.page.fill(`#aa-new-order-modal [name="${n}"]`, v);
  await sel("productId", String(productId)); await fill("customerName", "Browser Customer"); await fill("phone", "08031112233"); await fill("whatsapp", "08031112233");
  await fill("address", "5 Test Street, Ikeja"); await sel("state", "Lagos");
  await c.page.click('#aa-new-order-modal button[type="submit"]');
  await c.page.waitForSelector("#aa-new-order-modal", { state: "detached" });
  await c.page.waitForTimeout(1500);
  const made = await q<{ created_by: string; customer_name: string }>(db, sql`SELECT created_by, customer_name FROM orders WHERE product_id = ${productId}`);
  assert.equal(made.length, 1); assert.equal(made[0].created_by, admin.email); assert.equal(made[0].customer_name, "Browser Customer");
  assert.match(await c.page.evaluate(() => document.body.innerText), /Browser Customer/, "the new order is listed after the modal closes");
  assert.deepEqual(c.errs, []);
  await c.browser.close();
});
