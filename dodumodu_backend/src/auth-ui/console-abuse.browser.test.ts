// The "Abuse & spam" panel in a real browser against the composed app: only administrators see it, held orders and RPF
// suspects are listed and filterable, release acts once, and blocking is a click plus the authenticator step-up.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { app as composed } from "../app";
import { q, sql } from "../auth/sql";
import { openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow } from "../auth/mfa-test-kit";
import * as repo from "../abuse/holdRepo";

const NS = "/4ehhi-5deggi", ORIGIN = "https://shop.example.com";
const db = openTestDb(); const s = testSecrets(); const tag = makeTag("abu");
const env = { DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "production", ADMIN_BASE_PATH: NS, ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1", MAX_ORDER_QUANTITY: "20",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
  RATE_LIMIT_ADMIN_PER_MINUTE: "100000", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "100000", RATE_LIMIT_KV: { get: async () => null, put: async () => undefined } } as never;
let opened: any = null; let productId = 0;
const NET = 1 + Math.floor(Math.random() * 200); let n = 0; const ip = () => `10.${NET}.67.${(n++ % 250) + 1}`;
declare const document: any;
after(async () => {
  await opened?.close().catch(() => undefined);
  await q(db, sql`DELETE FROM moderation_blocks WHERE value LIKE ${tag + "%"} OR value LIKE '10.89.%'`).catch(() => undefined);
  await q(db, sql`DELETE FROM held_orders WHERE reference LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM abuse_alerts WHERE subject_value LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE product_id = ${productId})`);
  await q(db, sql`DELETE FROM orders WHERE product_id = ${productId}`); await q(db, sql`DELETE FROM products WHERE id = ${productId}`);
  await cleanupTag(db, tag); await closePools();
});
const call = (method: string, path: string, cookie?: string, body?: BodyInit | null) => { const a = ip();
  return composed.fetch(new Request(`${ORIGIN}${path}`, { method, redirect: "manual", headers: { host: "shop.example.com", origin: ORIGIN, "cf-connecting-ip": a, "x-test-ip": a, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: method === "GET" ? undefined : (body ?? "{}") }), env); };
async function session(label: string, role: "admin" | "mono", grants: string[]) {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role: "admin" });
  await q(db, sql`UPDATE aa_users SET role = ${role}, is_superuser = ${role === "admin"}, is_staff = true, device_window_until = now() + interval '1 hour' WHERE id = ${u.id}::uuid`);
  for (const g of grants) await q(db, sql`INSERT INTO aa_user_permissions (user_id, perm) VALUES (${u.id}::uuid, ${g})`);
  const vid = newVid(); const f = await newTotpFlow(db, s, u, { vid, stage: "ready" });
  const r = await call("POST", `${NS}/auth/session`, `__Host-aaf=${f.token}; __Host-vid=${vid}`);
  const sc = r.headers.get("set-cookie") ?? ""; const did = /__Host-did=([^;]+)/.exec(sc)?.[1];
  return { id: u.id, cookie: `__Host-sid=${/__Host-sid=([^;]+)/.exec(sc)![1]}${did ? `; __Host-did=${did}` : ""}; __Host-vid=${vid}` };
}
async function open(pw: any, cookie: string) {
  const browser = opened = await pw.chromium.launch({ args: ["--no-proxy-server"] }); const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.route("**/*", async (route: any) => { const rq = route.request(); const url = new URL(rq.url());
    const res = await call(rq.method(), url.pathname + url.search, cookie, rq.postData() ?? undefined);
    return route.fulfill({ status: res.status, headers: Object.fromEntries([...(res.headers as any)] as [string, string][]), body: Buffer.from(await res.arrayBuffer()) }); });
  const page = await ctx.newPage(); const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e)));
  // The security headers are enforced here (the pages are served by the real app), so a blocked script, style or request shows up as a console error.
  page.on("console", (m: any) => { if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) errs.push(m.text()); });
  page.on("dialog", (d: any) => d.accept());
  await page.goto(`${ORIGIN}${NS}/`); await page.waitForTimeout(1800);
  return { browser, page, errs };
}

test("Abuse & spam panel: admin-only link, filterable lists, release acts once, blocking needs the step-up", async () => {
  const root = execSync("npm root -g", { encoding: "utf8" }).trim(); const pw = createRequire(`${root}/`)("playwright");
  productId = (await q<{ id: number }>(db, sql`INSERT INTO products (slug, name, description, price) VALUES (${`${tag}-p`}, 'Abuse UI fixture', 'x', 1000000) RETURNING id`))[0].id;
  const admin = await session("admin", "admin", []);
  const mono = await session("mono", "mono", ["orders.view"]);
  const phone = `0803${4000000 + Math.floor(Math.random() * 900000)}`;
  const held = (await repo.insertHeld(db, { idempotencyKey: crypto.randomUUID(), reference: `${tag}-ref`, phoneNorm: `234${phone.slice(1)}`, phone, customerName: "Held Hannah",
    address: "1 Held Road", ip: "10.89.1.1", deviceId: `${tag}-devicetoken-1234`, clientKind: "browser", browser: "Chrome 120 · Android", reason: "6 orders from this phone in 24h",
    payload: { productId, quantity: 1, customerName: "Held Hannah", phone, whatsapp: phone, address: "1 Held Road", state: "Lagos", deliveryDate: "tomorrow", paymentMethod: "cod" } }))!;
  const dev = `${tag}-rpfdevice-9999`;
  const alert = (await repo.upsertOpenAlert(db, { scope: "device", value: dev, ip: "10.89.2.2", deviceId: dev, clientKind: "browser", browser: "Safari 17 · iOS", phones: 6, orders: 7, orderIds: [], windowMinutes: 60 })).row;

  // a non-admin never gets the link
  let c = await open(pw, mono.cookie);
  assert.equal(await c.page.locator("#aa-abuse-link").count(), 0, "no Abuse & spam link for a non-admin");
  await c.browser.close();

  // the administrator
  c = await open(pw, admin.cookie); const page = c.page;
  await page.waitForSelector("#aa-abuse-link", { timeout: 8000 });
  assert.ok(Number((await page.locator("#aa-abuse-badge").innerText()).trim()) >= 2, "the badge counts open holds and suspects");
  await page.click("#aa-abuse-link"); await page.waitForSelector("#aa-abuse-panel");
  await page.waitForFunction(() => /Held Hannah/.test(document.body.innerText), null, { timeout: 8000 });
  let text = await page.evaluate(() => document.getElementById("aa-abuse-panel")!.innerText);
  assert.match(text, /Held Hannah/); assert.match(text, /6 orders from this phone/); assert.match(text, /Chrome 120 · Android/); assert.match(text, /10\.89\.1\.1/);
  // search filter narrows, status filter switches
  await page.fill('#aa-abuse-panel input[type="search"]', "no-such-person"); await page.keyboard.press("Enter"); await page.waitForTimeout(800);
  assert.match(await page.evaluate(() => document.getElementById("aa-abuse-panel")!.innerText), /Nothing here/);
  await page.fill('#aa-abuse-panel input[type="search"]', phone); await page.keyboard.press("Enter"); await page.waitForTimeout(800);
  assert.match(await page.evaluate(() => document.getElementById("aa-abuse-panel")!.innerText), /Held Hannah/);

  // RPF tab shows the evidence needed to block: device, browser, address, counts
  await page.click('#aa-abuse-panel button:has-text("RPF Suspects")'); await page.waitForFunction(() => /Safari 17/.test(document.getElementById("aa-abuse-panel")!.innerText), null, { timeout: 8000 });
  text = await page.evaluate(() => document.getElementById("aa-abuse-panel")!.innerText);
  assert.match(text, /Safari 17 · iOS/); assert.match(text, /10\.89\.2\.2/); assert.match(text, /6 phones/);
  assert.match(text, /…/, "the device token is masked on screen");

  // Block: without a step-up the server refuses and the dialog asks for the authenticator code
  await page.click('#aa-abuse-panel button:has-text("Block…")'); await page.waitForSelector("#aa-abuse-dialog");
  await page.click('#aa-abuse-dialog button:has-text("Block")'); await page.waitForTimeout(1000);
  assert.match(await page.locator("#aa-abuse-dialog [role=alert]").innerText(), /authenticator code/i);
  assert.equal((await repo.getAlert(db, alert.id))!.status, "open", "nothing was blocked without the step-up");
  // with a fresh step-up window the same click goes through and blocks both the device and the address
  await q(db, sql`UPDATE aa_sessions SET stepup_until = now() + interval '10 minutes' WHERE user_id = ${admin.id}::uuid`);
  await page.click('#aa-abuse-dialog button:has-text("Block")'); await page.waitForFunction(() => !document.getElementById("aa-abuse-dialog"), null, { timeout: 8000 });
  const after = (await repo.getAlert(db, alert.id))!; assert.equal(after.status, "blocked");
  assert.equal((await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM moderation_blocks WHERE active AND value IN (${dev}, '10.89.2.2')`))[0].n, 2);

  // Release on the Spam tab creates one order
  await page.click('#aa-abuse-panel button:has-text("Spam orders")'); await page.waitForTimeout(800);
  await page.fill('#aa-abuse-panel input[type="search"]', phone); await page.keyboard.press("Enter"); await page.waitForTimeout(800);
  await page.click('#aa-abuse-panel button:has-text("Release as order")'); await page.waitForTimeout(1500);
  assert.equal((await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM orders WHERE idempotency_key = ${held.idempotency_key}`))[0].n, 1);
  assert.deepEqual(c.errs, []);
  await c.browser.close();
});
