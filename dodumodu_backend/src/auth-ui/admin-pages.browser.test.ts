// The management pages in a REAL browser (Chromium), served by the real dispatcher from the generated bundle,
// against the real routes and database. Skipped (not failed) where Playwright/Chromium is not installed.
//   alignment (header cells line up with row cells), no sideways page overflow on a phone, hidden scrollbar that
//   still scrolls, search + empty state, real-value copy, details, confirmed revokes, session lost while open,
//   and the invite page (fragment token removed from the address bar, redeemed only by the button).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { app as composed } from "../app";
import { q, q1, sql } from "../auth/sql";
import {
  openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow,
} from "../auth/mfa-test-kit";

// Code passed to page.evaluate() runs in the browser; these only tell TypeScript those globals exist there.
declare const document: any;
declare const getComputedStyle: (e: unknown) => any;

type PW = { chromium: { launch(): Promise<any> } };
let pw: PW | null = null;
try {
  const root = execSync("npm root -g", { encoding: "utf8" }).trim();
  pw = (createRequire(`${root}/`)("playwright") as PW);
} catch { try { pw = createRequire(import.meta.url)("playwright") as PW; } catch { pw = null; } }

const NS = "/4ehhi-5deggi", ORIGIN = "https://shop.example.com";
const db = openTestDb();
const s = testSecrets();
const tag = makeTag("ui");
const env = {
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "production", ADMIN_BASE_PATH: NS, ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
  RATE_LIMIT_ADMIN_PER_MINUTE: "100000", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "100000",
  RATE_LIMIT_KV: { get: async () => null, put: async () => undefined },
} as never;
after(async () => {
  await q(db, sql`DELETE FROM aa_device_invites WHERE created_by IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await cleanupTag(db, tag); await closePools();
});

const NET = 1 + Math.floor(Math.random() * 200);
let n = 0;
const ip = () => `10.${NET}.66.${(n++ % 250) + 1}`;
const call = (method: string, path: string, cookie?: string, headers: Record<string, string> = {}, body?: BodyInit | null) => {
  const addr = ip();
  return composed.fetch(new Request(`${ORIGIN}${path}`, { method, redirect: "manual",
    headers: { host: "shop.example.com", origin: ORIGIN, "cf-connecting-ip": addr, "x-test-ip": addr,
      ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...headers },
    body: method === "GET" ? undefined : (body ?? "{}") }), env);
};
async function signIn(label: string, role: "admin" | "staff" = "admin") {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role });
  await q(db, sql`UPDATE aa_users SET device_window_until = now() + interval '1 hour' WHERE id = ${u.id}::uuid`);
  const vid = newVid(); const f = await newTotpFlow(db, s, u, { vid, stage: "ready" });
  const res = await call("POST", `${NS}/auth/session`, `__Host-aaf=${f.token}; __Host-vid=${vid}`, { "user-agent": `Browser-${label}` });
  assert.equal(res.status, 200, await res.text());
  const sc = res.headers.get("set-cookie") ?? "";
  const did = /__Host-did=([^;]+)/.exec(sc)?.[1];
  return { u, cookie: `__Host-sid=${/__Host-sid=([^;]+)/.exec(sc)![1]}${did ? `; __Host-did=${did}` : ""}; __Host-vid=${vid}` };
}

test("management pages in Chromium", { skip: pw ? false : "playwright/chromium not installed" }, async (t) => {
  const admin = await signIn("admin"), zeta = await signIn("zeta");
  for (let i = 0; i < 3; i++) await createEnrolledUser(db, s, `${tag}-extra${i}@example.com`, { role: "staff" });
  await q(db, sql`UPDATE aa_admin_devices SET label = 'Zeta Pixel Phone' WHERE user_id = ${zeta.u.id}::uuid`);
  const browser = await pw!.chromium.launch();
  let cookie = admin.cookie;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"], baseURL: ORIGIN });
  await ctx.route("**/*", async (route: any) => {
    const r = route.request(); const u = new URL(r.url());
    const res = await call(r.method(), u.pathname + u.search, cookie, { accept: r.headers().accept ?? "*/*" }, r.postData() ?? undefined);
    return route.fulfill({ status: res.status, headers: Object.fromEntries([...(res.headers as any)] as [string, string][]), body: Buffer.from(await res.arrayBuffer()) });
  });
  const open = async (path: string, width = 1280) => {
    const page = await ctx.newPage(); const errors: string[] = [];
    await page.setViewportSize({ width, height: 800 });
    page.on("pageerror", (e: unknown) => errors.push(String(e)));
    page.on("console", (m: any) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await page.goto(`${ORIGIN}${NS}${path}`); await page.waitForSelector("#list .row, #list .state", { timeout: 8000 });
    if (process.env.UI_SHOTS) await page.screenshot({ path: `${process.env.UI_SHOTS}/${path.replace(/\W/g, "")}-${width}.png` });
    return { page, errors };
  };
  // Wait until the list is exactly ONE row and it is the expected one (never match a stale render).
  const oneRowWith = (page: any, text: string) =>
    page.waitForFunction((t: string) => { const r = document.querySelectorAll("#list .row"); return r.length === 1 && (r[0].textContent || "").includes(t); }, text, { timeout: 8000 });
  const alignment = (page: any) => page.evaluate(() => {
    const heads = Array.from(document.querySelectorAll(".table-head .th") as any[]).map((e) => Math.round(e.getBoundingClientRect().left));
    const row = document.querySelector(".table-body .row")!;
    const cells = Array.from(row.children as any[]).filter((e: any) => e.classList.contains("cell")).map((e) => Math.round(e.getBoundingClientRect().left));
    return { heads, cells };
  });

  await t.test("every page: header aligns with rows, no errors, nothing clipped sideways on a phone", async () => {
    for (const p of ["/users/", "/devices/", "/sessions/"]) {
      const { page, errors } = await open(p);
      const a = await alignment(page);
      assert.deepEqual(a.cells, a.heads, `${p}: header cells line up with row cells`);
      assert.deepEqual(errors, [], `${p}: no page errors`);
      await page.close();
      const phone = await open(p, 390);
      const o = await phone.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(o.sw <= o.cw, `${p}: no sideways page scroll on a phone (${o.sw} > ${o.cw})`);
      await phone.page.close();
    }
  });

  await t.test("scrollbar hidden but scrolling works (mouse, keyboard, programmatic)", async () => {
    const { page } = await open("/devices/", 900);        // narrower than the table's minimum -> it must scroll
    const info = await page.evaluate(() => { const el = document.querySelector(".table-scroll") as any; const cs = getComputedStyle(el);
      el.scrollLeft = 80; return { ox: cs.overflowX, sb: (cs as any).scrollbarWidth, can: el.scrollWidth > el.clientWidth, left: el.scrollLeft, bar: el.offsetHeight - el.clientHeight }; });
    assert.equal(info.ox, "auto"); assert.equal(info.sb, "none"); assert.ok(info.can, "content wider than the box");
    assert.ok(info.left > 0, "programmatic scroll works"); assert.equal(info.bar, 0, "no scrollbar is drawn");
    await page.mouse.move(400, 300); await page.mouse.wheel(60, 0); await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => (document.querySelector(".table-scroll") as any).scrollLeft) > 0);
    await page.close();
  });

  await t.test("users: server-side search, empty state, copy puts the FULL id on the clipboard", async () => {
    const { page } = await open("/users/");
    assert.ok((await page.locator("#list .row").count()) >= 5);
    await page.fill("#search", `${tag}-zeta`); await oneRowWith(page, `${tag}-zeta@example.com`);
    assert.equal(await page.locator("#count").innerText(), "1 user");
    await page.fill("#search", "zzzz-nobody"); await page.waitForSelector("#list .state");
    assert.match(await page.locator("#list").innerText(), /No users match/);
    await page.fill("#search", `${tag}-zeta`); await oneRowWith(page, `${tag}-zeta@example.com`);
    await page.locator('button[title="Copy user ID"]').first().click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), zeta.u.id);
    await page.locator('button[title="Copy email"]').first().click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${tag}-zeta@example.com`);
    await page.close();
  });

  await t.test("devices: owner shown, search by label, details open and close", async () => {
    const { page } = await open("/devices/");
    await page.fill("#search", "pixel phone"); await oneRowWith(page, `${tag}-zeta@example.com`);
    assert.match(await page.locator("#list .row").innerText(), new RegExp(`${tag}-zeta@example.com`));
    await page.getByRole("button", { name: "Details" }).click();
    assert.match(await page.locator(".row-detail").innerText(), /device id/i);
    await page.getByRole("button", { name: "Details" }).click();
    assert.equal(await page.locator(".row-detail").count(), 0);
    await page.close();
  });

  await t.test("sessions: all-users view for admins; End asks first and acts on the right session; no false success", async () => {
    const victim = await signIn("victim");
    const { page } = await open("/sessions/");
    await page.waitForSelector("#scope.is-on"); await page.selectOption("#scope", "all");
    await page.fill("#search", `${tag}-victim`); await oneRowWith(page, `${tag}-victim@example.com`);
    await q(db, sql`UPDATE aa_sessions SET stepup_until = now() + interval '10 minutes' WHERE user_id = ${admin.u.id}::uuid`);
    page.once("dialog", (d: any) => d.dismiss());
    await page.getByRole("button", { name: "End", exact: true }).click(); await page.waitForTimeout(300);
    assert.equal((await q(db, sql`SELECT 1 FROM aa_sessions WHERE user_id = ${victim.u.id}::uuid`)).length, 1, "cancelled: nothing ended");
    page.once("dialog", (d: any) => d.accept());
    await page.getByRole("button", { name: "End", exact: true }).click();
    await page.waitForSelector("#list .state"); assert.match(await page.locator("#note").innerText(), /Session ended/);
    assert.equal((await q(db, sql`SELECT 1 FROM aa_sessions WHERE user_id = ${victim.u.id}::uuid`)).length, 0);
    assert.equal((await q(db, sql`SELECT 1 FROM aa_sessions WHERE user_id = ${admin.u.id}::uuid`)).length, 1, "only the chosen user was touched");
    await page.close();
  });

  await t.test("a session lost while the page is open sends the page to sign-in", async () => {
    const lost = await signIn("lost"); cookie = lost.cookie;
    const { page } = await open("/devices/");
    await q(db, sql`DELETE FROM aa_sessions WHERE user_id = ${lost.u.id}::uuid`);
    await page.fill("#search", "x");
    await page.waitForURL(`**${NS}/sign-in/**`, { timeout: 8000 });
    cookie = admin.cookie; await page.close();
  });

  await t.test("invite page: fragment token leaves the address bar; only the button redeems; link is single use", async () => {
    await q(db, sql`UPDATE aa_sessions SET stepup_until = now() + interval '10 minutes' WHERE user_id = ${admin.u.id}::uuid`);
    const made = await call("POST", `${NS}/admin-v2/devices/invite`, admin.cookie);
    const url = ((await made.json()) as { invite_url: string }).invite_url;
    assert.ok(url.startsWith(`${ORIGIN}${NS}/device/accept/#`));
    cookie = "";                                           // the new device has no session
    const page = await ctx.newPage(); await page.goto(url); await page.waitForSelector("#accept");
    assert.equal(new URL(page.url()).hash, "", "token removed from the address bar");
    const used = await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM aa_device_invites WHERE user_id = ${admin.u.id}::uuid AND used_at IS NOT NULL`);
    assert.equal(used!.n, 0, "opening the page redeemed nothing");
    await page.click("#accept"); await page.waitForSelector("#continue:not([hidden])");
    assert.match(await page.locator("#note").innerText(), /Device added/);
    assert.equal(await page.locator("#continue").getAttribute("href"), `${NS}/sign-in/`);
    const again = await ctx.newPage(); await again.goto(url); await again.click("#accept");
    await again.waitForSelector(".note.error"); assert.match(await again.locator("#note").innerText(), /invalid, expired or already used/);
    cookie = admin.cookie;
  });

  await browser.close();
});
