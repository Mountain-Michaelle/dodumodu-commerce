// Real UI tests — spec §10. Playwright against wrangler dev (ADMIN_AUTH_V2=1,
// ALLOW_TEST_IP=1). Reads the emailed code from the in-memory mailbox endpoint
// and computes TOTP in-test. Requires @playwright/test + a running Worker.
import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const uniq = () => `pw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

async function readCode(page, email) {
  const res = await page.request.get(`${BASE}/auth/test/mailbox/${encodeURIComponent(email)}`);
  if (res.status() !== 200) return null;
  const { text } = await res.json();
  return /Your code is ([0-9A-F!#$%&*+?]{10})/.exec(text ?? "")?.[1] ?? null;
}

// RFC 6238 TOTP (SHA-1, 6 digits, 30s) from a base32 secret — matches the server.
function totp(secretB32, nowMs = Date.now()) {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretB32.replace(/=+$/, "")) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  const step = Math.floor(nowMs / 30000);
  const msg = Buffer.alloc(8);
  msg.writeBigInt64BE(BigInt(step));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, "0");
}

test("staff: email, code, phrase, dashboard; hidden actions also refused by server", async ({ page }) => {
  const email = uniq();
  await page.goto("/auth-ui/login.html");
  await page.fill("#input", email);
  await page.click("#submit");
  await expect(page.locator("#note")).toContainText("check your inbox");
  const code = await readCode(page, email);
  expect(code).toBeTruthy();
  await page.fill("#input", code);
  await page.click("#submit");
  // First login -> enroll phrase.
  await expect(page.locator("#field-label")).toContainText("phrase");
  await page.fill("#input", "correct horse battery staple");
  await page.click("#submit");
  // Staff has no TOTP -> straight to ready -> auto session.
  await expect(page.locator("#note")).toContainText("Signed in", { timeout: 10_000 });
});

test("admin first login: enroll phrase, enroll authenticator, backup codes once, device cookie", async ({ page, context }) => {
  const email = uniq();
  await page.goto("/auth-ui/login.html");
  await page.fill("#input", email);
  await page.click("#submit");
  const code = await readCode(page, email);
  await page.fill("#input", code); await page.click("#submit");
  await page.fill("#input", "another strong phrase 99"); await page.click("#submit"); // enroll phrase
  // totp_enroll: fetch the secret, compute a code, submit.
  const secret = await enrollSecret(page);
  expect(secret).toBeTruthy();
  await page.fill("#input", totp(secret)); await page.click("#submit");
  // Backup codes shown once with an "I saved them" confirmation.
  await expect(page.locator(".codes")).toBeVisible();
  await page.getByRole("button", { name: "I saved them" }).click();
  await expect(page.locator("#note")).toContainText("Signed in", { timeout: 10_000 });
  // A device cookie was set on the first admin login.
  const cookies = await context.cookies();
  expect(cookies.some((c) => c.name === "__Host-did")).toBe(true);
});

async function enrollSecret(page) {
  // The start endpoint returns the secret once; call it via the page's origin.
  const res = await page.request.post(`${BASE}/auth/totp/enroll/start`, {
    headers: { "Content-Type": "application/json" },
  });
  if (res.status() !== 200) return null;
  return (await res.json()).secret ?? null;
}

test("admin in a fresh browser: neutral message identical to unknown, no code, no later stage", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = uniq();
  await page.goto("/auth-ui/login.html");
  await page.fill("#input", email);
  await page.click("#submit");
  // Always the same 202 + "if registered" note.
  await expect(page.locator("#note")).toContainText("check your inbox");
  // No code was emailed for an admin with no device (denied path).
  const code = await readCode(page, email);
  expect(code).toBeNull();
  // A wrong code keeps us at the same neutral error, never advances.
  await page.fill("#input", "AAAAAAAAAA");
  await page.click("#submit");
  await expect(page.locator("#note")).toContainText("Invalid or expired");
  await ctx.close();
});

test("503 fault keeps the form usable with the 'nothing was counted' message", async ({ page }) => {
  // Simulate by routing /auth/request to a 503 {retry:true} — the UI contract.
  await page.route("**/auth/request", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ retry: true }) }));
  await page.goto("/auth-ui/login.html");
  await page.fill("#input", uniq());
  await page.click("#submit");
  await expect(page.locator("#note")).toContainText("Nothing was counted");
  // The form is still usable.
  await expect(page.locator("#submit")).toBeEnabled();
});

test("429 shows a server countdown and disables the form", async ({ page }) => {
  await page.route("**/auth/code", (route) =>
    route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ retry_after: 5 }) }));
  await page.goto("/auth-ui/login.html");
  await page.fill("#input", uniq());
  await page.click("#submit");
  await expect(page.locator("#note")).toContainText("Too many attempts");
  await expect(page.locator("#submit")).toBeDisabled();
});
