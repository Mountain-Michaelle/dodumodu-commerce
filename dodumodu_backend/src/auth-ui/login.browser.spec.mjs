// Real-browser test of the login page (Chromium via Playwright): the lost-email form and the
// reload-resume behaviour. The API is mocked per test, so what is pinned is what the PAGE does:
//   * a reload within the server's window resumes the SAME stage (no new email is requested)
//   * outside the window (status 404) the normal email stage shows
//   * the lost-email form posts the username, and never claims an account was found
// Run: npm run test:ui:browser   (needs Playwright's Chromium; not part of test:db)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); }
catch { throw new Error("playwright is required for test:ui:browser (npm i -D playwright && npx playwright install chromium)"); }

const here = dirname(fileURLToPath(import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };
let server, base, browser;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const file = url.pathname === "/admin/login" ? "login.html" : url.pathname.replace(/^\/auth-ui\//, "");
    try {
      const body = readFileSync(join(here, file));
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

/** Open the login page with a mocked API. `routes` maps "METHOD /path" -> {status, json}. */
async function open(routes) {
  const page = await browser.newPage();
  const calls = [];
  await page.route("**/admin/auth/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/admin/auth", "");
    const key = `${req.method()} ${path}`;
    calls.push({ key, body: req.postData() });
    const r = routes[key] ?? (key === "GET /device/available" ? { status: 200, json: { available: false } } : { status: 404, json: { error: "Not found" } });
    await route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.json ?? {}) });
  });
  await page.goto(`${base}/admin/login`);
  await page.waitForLoadState("networkidle");
  return { page, calls };
}
const visible = (page, id) => page.locator(`#${id}`).isVisible();

test("no flow in progress: the email stage shows with the lost-email link", async () => {
  const { page } = await open({});
  assert.equal(await page.locator("#field-label").innerText(), "Email");
  assert.equal(await visible(page, "lost-link"), true);
  assert.equal(await visible(page, "back-link"), false);
  await page.close();
});

test("lost email: link opens the form, the username is posted, and the answer never says an account exists", async () => {
  const { page, calls } = await open({ "POST /lost-email": { status: 202, json: { ok: true } } });
  await page.click("#lost-link");
  assert.equal(await page.locator("#field-label").innerText(), "Username or email");
  assert.equal(await page.locator("#submit").innerText(), "Request help");
  assert.equal(await visible(page, "back-link"), true);
  assert.equal(await visible(page, "lost-link"), false);
  await page.fill("#input", "  Someone@Example.com ");
  await page.click("#submit");
  await page.waitForSelector("#note:not([hidden])");
  const note = await page.locator("#note").innerText();
  assert.match(note, /If that matches an account/i);
  assert.doesNotMatch(note, /account (was )?found|code was sent|exists\b/i);
  const posted = calls.find((c) => c.key === "POST /lost-email");
  assert.deepEqual(JSON.parse(posted.body), { username: "Someone@Example.com" });
  assert.ok(!calls.some((c) => c.key === "POST /request"), "no sign-in code was requested");
  await page.click("#back-link");
  assert.equal(await page.locator("#field-label").innerText(), "Email");
  await page.close();
});

test("lost email: a 429 shows the wait message instead of success", async () => {
  const { page } = await open({ "POST /lost-email": { status: 429, json: { retry_after: 120 } } });
  await page.click("#lost-link");
  await page.fill("#input", "x@example.com");
  await page.click("#submit");
  await page.waitForFunction(() => /Please try again in/.test(document.getElementById("note").textContent));
  await page.close();
});

test("reload inside the window resumes the code step without requesting a new email", async () => {
  const { page, calls } = await open({ "GET /status": { status: 200, json: { stage: "otp", email_masked: "a***@example.com", strict: false, expires_in: 120 } } });
  assert.equal(await page.locator("#field-label").innerText(), "Code");
  assert.match(await page.locator("#subtitle").innerText(), /a\*\*\*@example\.com/);
  assert.match(await page.locator("#note").innerText(), /Welcome back/);
  assert.equal(await visible(page, "lost-link"), false, "lost-email is an email-stage option only");
  assert.ok(!calls.some((c) => c.key === "POST /request" || c.key === "POST /resend"), "nothing was re-sent on reload");
  await page.close();
});

test("reload resumes the authenticator step", async () => {
  const { page } = await open({ "GET /status": { status: 200, json: { stage: "totp", email_masked: "a***@example.com", strict: false, expires_in: 90 } } });
  assert.equal(await page.locator("#field-label").innerText(), "Authenticator");
  await page.close();
});

test("reload on the ready step offers 'Sign in' directly", async () => {
  const { page } = await open({ "GET /status": { status: 200, json: { stage: "ready", email_masked: "a***@example.com", strict: false, expires_in: 60 } } });
  assert.equal(await page.locator("#submit").innerText(), "Sign in");
  await page.close();
});

test("reload on authenticator setup fetches a fresh QR and explains it", async () => {
  const { page, calls } = await open({
    "GET /status": { status: 200, json: { stage: "totp_enroll", email_masked: "a***@example.com", strict: false, expires_in: 100 } },
    "POST /totp/enroll/start": { status: 200, json: { secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/x:y?secret=JBSWY3DPEHPK3PXP", expires_in: 100 } },
  });
  await page.waitForSelector("#enroll-box:not([hidden])");
  assert.ok(calls.some((c) => c.key === "POST /totp/enroll/start"));
  assert.match(await page.locator("#enroll-box").innerText(), /JBSWY3DPEHPK3PXP/);
  await page.close();
});

test("reload on the backup-codes step re-issues and shows a fresh set", async () => {
  const codes = ["AAAAA-11111", "BBBBB-22222", "CCCCC-33333", "DDDDD-44444", "EEEEE-55555", "FFFFF-66666", "GGGGG-77777", "HHHHH-88888"];
  const { page, calls } = await open({
    "GET /status": { status: 200, json: { stage: "backup_codes", email_masked: "a***@example.com", strict: false, expires_in: 100 } },
    "POST /backup-codes/reissue": { status: 200, json: { backup_codes: codes } },
  });
  await page.waitForSelector("#note .codes");
  assert.ok(calls.some((c) => c.key === "POST /backup-codes/reissue"));
  const shown = await page.locator("#note .codes span").allInnerTexts();
  assert.deepEqual(shown, codes);
  assert.match(await page.locator("#hint").innerText(), /replaced/i);
  await page.close();
});

test("outside the window the server says 404 and the email stage shows", async () => {
  const { page } = await open({ "GET /status": { status: 404, json: { error: "Not found" } } });
  assert.equal(await page.locator("#field-label").innerText(), "Email");
  assert.equal(await visible(page, "lost-link"), true);
  await page.close();
});
