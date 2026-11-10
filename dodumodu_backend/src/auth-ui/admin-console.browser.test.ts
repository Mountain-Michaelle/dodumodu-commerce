import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { app as composed } from "../app";
import { q, sql } from "../auth/sql";
import { openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow } from "../auth/mfa-test-kit";
const NS = "/4ehhi-5deggi", ORIGIN = "https://shop.example.com";
const db = openTestDb(); const s = testSecrets(); const tag = makeTag("con");
const env = { DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "production", ADMIN_BASE_PATH: NS, ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
  RATE_LIMIT_ADMIN_PER_MINUTE: "100000", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "100000", RATE_LIMIT_KV: { get: async () => null, put: async () => undefined } } as never;
let opened: any = null;
after(async () => { await opened?.close().catch(() => undefined); await cleanupTag(db, tag); await closePools(); });
const NET = 1 + Math.floor(Math.random() * 200); let n = 0; const ip = () => `10.${NET}.55.${(n++ % 250) + 1}`;
declare const document: any; declare const location: any;
const call = (method: string, path: string, cookie?: string, body?: BodyInit | null) => { const a = ip();
  return composed.fetch(new Request(`${ORIGIN}${path}`, { method, redirect: "manual", headers: { host: "shop.example.com", origin: ORIGIN, "cf-connecting-ip": a, "x-test-ip": a, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: method === "GET" ? undefined : (body ?? "{}") }), env); };
test("console", async () => {
  const root = execSync("npm root -g", { encoding: "utf8" }).trim(); const pw = createRequire(`${root}/`)("playwright");
  const u = await createEnrolledUser(db, s, `${tag}-a@example.com`, { role: "admin" });
  await q(db, sql`UPDATE aa_users SET device_window_until = now() + interval '1 hour' WHERE id = ${u.id}::uuid`);
  for (let i = 0; i < 3; i++) await createEnrolledUser(db, s, `${tag}-x${i}@example.com`, { role: "staff" });
  const vid = newVid(); const f = await newTotpFlow(db, s, u, { vid, stage: "ready" });
  const r = await call("POST", `${NS}/auth/session`, `__Host-aaf=${f.token}; __Host-vid=${vid}`);
  const sc = r.headers.get("set-cookie") ?? ""; const did = /__Host-did=([^;]+)/.exec(sc)?.[1];
  const cookie = `__Host-sid=${/__Host-sid=([^;]+)/.exec(sc)![1]}${did ? `; __Host-did=${did}` : ""}; __Host-vid=${vid}`;
  const me = await (await call("GET", `${NS}/auth/me`, cookie)).json() as any;
  assert.ok(me.permissions.includes("products:write") && me.permissions.includes("media:write") && me.permissions.includes("categories:write"), "/auth/me must carry the legacy keys the console gates Add buttons on");
  const browser = opened = await pw.chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.route("**/*", async (route: any) => { const rq = route.request(); const url = new URL(rq.url());
    const res = await call(rq.method(), url.pathname + url.search, cookie, rq.postData() ?? undefined);
    return route.fulfill({ status: res.status, headers: Object.fromEntries([...(res.headers as any)] as [string, string][]), body: Buffer.from(await res.arrayBuffer()) }); });
  const page = await ctx.newPage(); const errs: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e)));
  const go = async (sec: string) => { await page.evaluate((h: string) => { location.hash = "#" + h; }, sec); await page.waitForTimeout(1500); };
  const buttons = () => page.evaluate(() => Array.from(document.querySelectorAll("button")).map((e: any) => (e.textContent || "").trim()));
  const rows = () => page.evaluate(() => document.querySelectorAll("tbody tr").length);
  await page.goto(`${ORIGIN}${NS}/`); await page.waitForTimeout(1500);
  for (const [sec, label] of [["categories", "+ Add category"], ["products", "+ Add product"], ["pages", "+ Add product"], ["testimonials", "+ Add testimonial"], ["media", "Choose image…"]]) {
    await go(sec); assert.ok((await buttons()).includes(label), `${sec}: missing "${label}"`);
  }
  await go("users");
  assert.ok((await rows()) >= 4, "users list must render rows");
  assert.match(await page.evaluate(() => document.querySelector(".list-summary")?.textContent ?? ""), /users/);
  assert.ok((await buttons()).includes("+ Add user"));
  await go("authlog"); assert.ok((await rows()) >= 1, "auth log must render rows");
  assert.ok(!(await buttons()).includes("+ Add user"), "Add user must not leak into the auth log");
  for (const sec of ["products", "media", "testimonials", "categories", "orders", "blocks"]) {
    await go("users"); await go(sec); assert.ok(!(await buttons()).includes("+ Add user"), `Add user leaked into ${sec}`);
  }
  // Leaving Users before it finishes loading must not paint its toolbar over the next section.
  await page.evaluate(() => { location.hash = "#users"; setTimeout(() => { location.hash = "#products"; }, 0); }); await page.waitForTimeout(2000);
  assert.ok(!(await buttons()).includes("+ Add user"), "late Users load leaked its toolbar");
  assert.deepEqual(errs, []);
  await browser.close();
});
