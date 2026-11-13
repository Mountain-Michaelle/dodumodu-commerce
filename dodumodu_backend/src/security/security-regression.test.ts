// Regression tests for the security audit. Each one pins a specific hole that was
// reproduced against the code before it was fixed; they must stay green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "../app";
import { ADMIN_CONSOLE_ASSETS } from "../generated/adminPages";
import { opayClient } from "../external/opayClient";

const kv = { get: async () => null, put: async () => {}, delete: async () => {} };
const baseEnv = (over: Record<string, unknown> = {}) => ({
  ENVIRONMENT: "production", ADMIN_BASE_PATH: "/zz-console", DATABASE_URL: "postgres://x@127.0.0.1:1/none",
  RATE_LIMIT_API_PER_MINUTE: "20", RATE_LIMIT_ADMIN_PER_MINUTE: "600", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "60",
  RATE_LIMIT_KV: kv, ...over,
}) as never;
const PLACEHOLDER = "FILL-IN-via-wrangler-secret-put";

test("reconcile-pending: unset secret and no header is refused", async () => {
  const r = await app.request("/reconcile-pending", { method: "POST" }, baseEnv());
  assert.equal(r.status, 401);
});
test("reconcile-pending: empty secret and empty header is refused", async () => {
  const r = await app.request("/reconcile-pending", { method: "POST", headers: { "x-cron-secret": "" } }, baseEnv({ RECONCILE_CRON_SECRET: "" }));
  assert.equal(r.status, 401);
});
test("reconcile-pending: placeholder secret is never accepted", async () => {
  const r = await app.request("/reconcile-pending", { method: "POST", headers: { "x-cron-secret": PLACEHOLDER } }, baseEnv({ RECONCILE_CRON_SECRET: PLACEHOLDER }));
  assert.equal(r.status, 401);
});
test("reconcile-pending: wrong secret refused", async () => {
  const r = await app.request("/reconcile-pending", { method: "POST", headers: { "x-cron-secret": "nope" } }, baseEnv({ RECONCILE_CRON_SECRET: "right-secret-123" }));
  assert.equal(r.status, 401);
});

const forged = { "cf-access-authenticated-user-email": "attacker@evil.com" };
for (const v2 of [undefined, "", "true", "0", "yes"]) {
  test(`admin: forged Access header is refused when ADMIN_AUTH_V2=${JSON.stringify(v2)}`, async () => {
    const r = await app.request("/zz-console/", { headers: forged }, baseEnv(v2 === undefined ? {} : { ADMIN_AUTH_V2: v2 }));
    assert.equal(r.status, 401);
  });
}

test("admin: CI bearer equal to the placeholder is refused", async () => {
  const r = await app.request("/zz-console/builds", { headers: { authorization: `Bearer ${PLACEHOLDER}` } }, baseEnv({ DEPLOY_TRIGGER_SECRET: PLACEHOLDER }));
  assert.equal(r.status, 401);
});

for (const secret of ["", PLACEHOLDER]) {
  test(`OPay webhook: signature made with a known key (${JSON.stringify(secret)}) is not valid`, async () => {
    const body = JSON.stringify({ x: 1 });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret || " "), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
    const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.equal(await opayClient.verifyWebhookSignature({ OPAY_WEBHOOK_SECRET: secret } as never, body, sig), false);
  });
}

test("console bundle is not served to an anonymous visitor", async () => {
  const file = Object.keys(ADMIN_CONSOLE_ASSETS).find((k) => k.endsWith(".js"))!;
  const r = await app.request(`/zz-console/assets/${file}`, {}, baseEnv({ ADMIN_AUTH_V2: "1" }));
  assert.notEqual(r.status, 200);
});

test("wrangler.toml [vars] carries no placeholder secrets and a well-formed origin list", () => {
  const toml = readFileSync(join(process.cwd(), "wrangler.toml"), "utf8");
  const vars = toml.split("[vars]")[1].split(/\n\[/)[0];
  const live = vars.split("\n").filter((l: string) => l.trim() && !l.trim().startsWith("#"));
  assert.deepEqual(live.filter((l: string) => /FILL-IN/i.test(l)), []);
  assert.deepEqual(live.filter((l: string) => /^(OPAY_(SECRET_KEY|WEBHOOK_SECRET|PUBLIC_KEY)|DEPLOY_TRIGGER_SECRET|GITHUB_DEPLOY_TOKEN|RECONCILE_CRON_SECRET)\s*=/.test(l.trim())), []);
  assert.deepEqual(live.filter((l: string) => /https:\/\/https:\/\//.test(l)), []);
});
