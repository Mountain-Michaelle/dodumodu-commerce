import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { adminRoute } from "./admin";
import { authRoute } from "../auth/routes";
import { adminBasePath, isLegacyAdminPath, rewriteAdminHtml, DEFAULT_ADMIN_BASE_PATH } from "../config/adminBase";
import type { Env } from "../env";
import { registerDbDriver } from "../db";
import { neonDriver } from "../dbDrivers/neon";
import { app as composedApp } from "../app";

/* Admin namespace dispatcher — spec §1, §6. */

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "fake://ns-test",
    ENVIRONMENT: "sandbox",
    ADMIN_BASE_PATH: DEFAULT_ADMIN_BASE_PATH,
    R2_BUCKET_NAME: "test-bucket",
    RATE_LIMIT_API_PER_MINUTE: "20",
    RATE_LIMIT_ADMIN_PER_MINUTE: "600",
    RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "60",
    RATE_LIMIT_ORDER_PER_PHONE_PER_HOUR: "5",
    ANALYTICS_IP_HMAC_SECRET: "",
    ANALYTICS_IP_HMAC_VERSION: "1",
    ANALYTICS_WARMUP_ENABLED: "false",
    ASSIGNMENT_MODE_ENABLED: "false",
    RL_MODE: "shadow",
    RL_AUTO_BLOCK: "shadow",
    RL_V2_ENABLED: "false",
    RL_VELOCITY_WINDOW_SECONDS: "3600",
    RL_VELOCITY_BLOCK_SECONDS: "3600",
    RL_V1_MIN_ORDERS: "0",
    RL_V1_MIN_PHONES: "0",
    RL_V2_MIN_ORDERS: "0",
    RL_V2_MIN_PHONES: "0",
    RL_V2_DEVICE_RATIO: "0",
    RL_WINDOW_SECONDS: "3600",
    RL_BLOCK_SECONDS: "3600",
    RL_ABUSE_IP_POSTS: "0",
    RL_ABUSE_DISTINCT_PHONES: "0",
    RL_ABUSE_FAILURES: "0",
    RL_ABUSE_SUCCESS_FLOOR: "0",
    RL_IP_ALLOWLIST: "",
    RL_PHONE_MAX_OPEN: "0",
    SUPPORT_WHATSAPP_URL: "",
    REFERRED_SLACK_WEBHOOK_URL: "",
    IMAGE_MODE: "derivative",
    MAX_UPLOAD_BYTES: "10485760",
    MAX_IMAGE_DIMENSION: "12000",
    IMAGE_KEY_PREFIX: "uploads",
    IMAGE_WIDTHS_HERO: "480,768,1200",
    IMAGE_WIDTHS_GALLERY: "320,640,960",
    IMAGE_WIDTHS_TESTIMONIAL: "320,640",
    IMAGE_WIDTHS_THUMBNAIL: "160,320",
    IMAGE_QUALITY_HERO: "80",
    IMAGE_QUALITY_GALLERY: "75",
    IMAGE_QUALITY_TESTIMONIAL: "70",
    IMAGE_QUALITY_THUMBNAIL: "70",
    CATALOG_EDGE_TTL: "300",
    CATALOG_EDGE_SWR: "3600",
    IMAGE_DELIVERY_BASE: "/media",
    PAGES_DEPLOY_HOOK: "",
    SITE_URL: "https://yoursite.com",
    MAX_ORDER_QUANTITY: "20",
    ALLOWED_ORIGINS: "https://yoursite.com",
    WORKER_URL: "https://your-worker.workers.dev",
    OPAY_BASE_URL: "https://sandboxapi.opaycheckout.com",
    ADMIN_OPERATORS: "",
    ADMIN_AUTH_V2: "0",
    ALLOW_TEST_IP: "",
    OPAY_PUBLIC_KEY: "",
    OPAY_SECRET_KEY: "",
    OPAY_MERCHANT_ID: "",
    OPAY_WEBHOOK_SECRET: "",
    TURNSTILE_SECRET_KEY: "",
    RECONCILE_CRON_SECRET: "",
    OTP_KEY: "",
    THROTTLE_KEY: "",
    TOTP_ENC_KEY: "",
    RESEND_API_KEY: "",
    TURNSTILE_SECRET: "",
    AUTH_FROM_EMAIL: "",
    DEPLOY_TRIGGER_SECRET: "",
    GITHUB_DEPLOY_TOKEN: "",
    MEDIA_BUCKET: {} as unknown as R2Bucket,
    RATE_LIMIT_KV: {
      get: async () => null,
      put: async () => undefined,
    } as unknown as KVNamespace,
    ...overrides,
  } as unknown as Env;
}

function dispatchApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const active = adminBasePath({ ENVIRONMENT: env.ENVIRONMENT, ADMIN_BASE_PATH: env.ADMIN_BASE_PATH });
    if (active !== null && (path === active || path.startsWith(active + "/"))) {
      const rest = path === active ? "/" : path.slice(active.length);
      const raw = c.req.raw;
      const init: RequestInit & { duplex?: "half" } = {
        method: raw.method,
        headers: raw.headers,
        duplex: "half",
      };
      if (raw.method !== "GET" && raw.method !== "HEAD") init.body = raw.body;
      const subReq = new Request("http://localhost" + rest, init);
      if (rest === "/auth" || rest.startsWith("/auth/")) {
        const authRest = rest === "/auth" ? "/" : rest.slice("/auth".length);
        return authRoute.request(authRest, init, c.env);
      }
      return adminRoute.fetch(subReq, c.env);
    }
    if (isLegacyAdminPath(path)) return c.text("Not found", 404);
    return next();
  });
  app.get("/:slug", (c) => c.text("product:" + c.req.param("slug")));
  return app;
}

test("custom namespace missing auth secrets returns sanitized structured 503", async () => {
  registerDbDriver(neonDriver);
  const env = makeEnv({
    ENVIRONMENT: "production",
    ADMIN_BASE_PATH: "/4ehhi-5deggi",
    ADMIN_AUTH_V2: "1",
    DATABASE_URL: "postgresql://user:password@example.com/database",
    OTP_KEY: "",
    THROTTLE_KEY: "",
    TOTP_ENC_KEY: "",
  });
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const app = dispatchApp(env);
    const response = await app.request("http://localhost/4ehhi-5deggi/auth/request", {
      method: "POST",
      headers: { Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com" }),
    }, env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("X-Correlation-ID")?.length, 24);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.error_id, response.headers.get("X-Correlation-ID"));
    assert.equal(body.retry, true);
    assert.equal(JSON.stringify(body).includes("password"), false);
    const serializedLog = JSON.stringify(errors);
    assert.match(serializedLog, /AUTH_SECRET_MISSING|auth secrets not configured/);
    assert.doesNotMatch(serializedLog, /admin@example\.com|password|postgresql:/);
  } finally {
    console.error = originalError;
  }
});

/* ---- Active namespace routing ---- */

test("admin console root requires auth under active namespace", async () => {
  const env = makeEnv({ ADMIN_BASE_PATH: "/e5he78f823523" });
  const app = dispatchApp(env);
  const res = await app.fetch(new Request("http://localhost/e5he78f823523/"), env);
  assert.equal(res.status, 401, "console root requires auth → 401");
});

test("admin assets work under active namespace", async () => {
  const env = makeEnv({ ADMIN_BASE_PATH: "/e5he78f823523" });
  const app = dispatchApp(env);
  const res = await app.fetch(new Request("http://localhost/e5he78f823523/assets/auth.js"), env);
  assert.equal(res.status, 200, "auth.js is public → 200");
  assert.ok((await res.text()).includes("AUTH"), "auth.js content served");
});

test("auth management HTML rewrites auth-ui assets into the active namespace", () => {
  const html = '<link rel="stylesheet" href="/auth-ui/auth.css"><script src="/auth-ui/devices.js" defer></script>';
  const rewritten = rewriteAdminHtml(html, "/e5he78f823523");
  assert.match(rewritten, /href="\/e5he78f823523\/assets\/auth\.css"/);
  assert.match(rewritten, /src="\/e5he78f823523\/assets\/devices\.js"/);
});

test("console assets are served under the active namespace", async () => {
  const namespace = "/e5he78f823523";
  const env = makeEnv({ ADMIN_BASE_PATH: namespace });
  const app = dispatchApp(env);
  const page = await app.fetch(new Request(`http://localhost${namespace}/`, {
    headers: { "Cf-Access-Authenticated-User-Email": "admin@example.com" },
  }), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes(`window.ADMIN_BASE_PATH="${namespace}"`) || html.includes(`window.ADMIN_BASE_PATH=${JSON.stringify(namespace)}`));
  const cssMatch = html.match(/href="[^"]*\/(admin\.[^.]+\.min\.css)"/);
  const jsMatch = html.match(/src="[^"]*\/(admin\.[^.]+\.min\.js)"/);
  assert.ok(cssMatch, "console CSS reference");
  assert.ok(jsMatch, "console JS reference");
  const css = await app.fetch(new Request(`http://localhost${namespace}/assets/${cssMatch![1]}`), env);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("Content-Type") ?? "", /^text\/css/);
  const js = await app.fetch(new Request(`http://localhost${namespace}/assets/${jsMatch![1]}`), env);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("Content-Type") ?? "", /^text\/javascript/);
});

/* ---- Legacy paths return 404 when not active ---- */

test("legacy /admin returns 404 when namespace is custom", async () => {
  const env = makeEnv({ ADMIN_BASE_PATH: "/e5he78f823523" });
  const app = dispatchApp(env);
  for (const p of ["/admin", "/admin/", "/admin/orders", "/admin/sign-in/"]) {
    const res = await app.fetch(new Request("http://localhost" + p), env);
    assert.equal(res.status, 404, `${p} should be 404`);
    assert.equal(await res.text(), "Not found");
  }
});

test("legacy /admin-v2 returns 404 when namespace is custom", async () => {
  const env = makeEnv({ ADMIN_BASE_PATH: "/e5he78f823523" });
  const app = dispatchApp(env);
  const res = await app.fetch(new Request("http://localhost/admin-v2"), env);
  assert.equal(res.status, 404, "/admin-v2 should be 404");
});

test("legacy /auth returns 404 when namespace is custom", async () => {
  const env = makeEnv({ ADMIN_BASE_PATH: "/e5he78f823523" });
  const app = dispatchApp(env);
  const res = await app.fetch(new Request("http://localhost/auth"), env);
  assert.equal(res.status, 404, "/auth should be 404");
});

/* ---- Legacy paths cannot reach product catch-all ---- */

test("legacy /admin does not fall through to product catch-all", async () => {
  const env = makeEnv({ ADMIN_BASE_PATH: "/e5he78f823523" });
  const app = dispatchApp(env);
  const res = await app.fetch(new Request("http://localhost/admin"), env);
  assert.equal(res.status, 404, "/admin must not reach product catch-all");
  assert.notEqual(await res.text(), "product:admin", "must not serve a product page");
});

/* ---- Public routes still work ---- */

test("public product page still works with custom namespace", async () => {
  const env = makeEnv({ ADMIN_BASE_PATH: "/e5he78f823523" });
  const app = dispatchApp(env);
  const res = await app.fetch(new Request("http://localhost/glow-serum"), env);
  assert.equal(res.status, 200, "public product page works");
  assert.equal(await res.text(), "product:glow-serum");
});

test("default namespace is /admin in development", async () => {
  const env = makeEnv();
  const active = adminBasePath({ ENVIRONMENT: env.ENVIRONMENT, ADMIN_BASE_PATH: env.ADMIN_BASE_PATH });
  assert.equal(active, "/admin");
});

test("custom namespace preserves POST auth requests", async () => {
  const namespace = "/4ehhi-5deggi";
  const env = makeEnv({
    ENVIRONMENT: "production",
    ADMIN_BASE_PATH: namespace,
    ADMIN_AUTH_V2: "1",
  });
  const app = dispatchApp(env);
  const res = await app.fetch(new Request(`http://localhost${namespace}/auth/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://example.com",
    },
    body: JSON.stringify({ email: "admin@example.com" }),
  }), env);
  assert.notEqual(res.status, 404, "POST auth handler, not methodless rewritten GET, must be reached");
  assert.equal(res.status, 403, "a mismatched origin reaches originGuard before auth DB work");
});

test("composed Worker custom namespace root rejects a missing v2 session", async () => {
  const namespace = "/4ehhi-5deggi";
  const v2Env = makeEnv({
    ENVIRONMENT: "production",
    ADMIN_BASE_PATH: namespace,
    ADMIN_AUTH_V2: "1",
  });
  const res = await composedApp.request(
    `http://localhost${namespace}/`,
    { headers: { Accept: "text/html" } },
    v2Env,
  );
  assert.equal(res.status, 401);
  assert.equal(await res.text(), "Unauthorized");
});

test("composed Worker custom namespace /me without v2 cookie falls through to legacy auth (401 JSON)", async () => {
  const namespace = "/4ehhi-5deggi";
  const v2Env = makeEnv({
    ENVIRONMENT: "production",
    ADMIN_BASE_PATH: namespace,
    ADMIN_AUTH_V2: "1",
  });
  const res = await composedApp.request(
    `http://localhost${namespace}/me`,
    { headers: { Accept: "application/json" } },
    v2Env,
  );
  assert.equal(res.status, 401);
  const body = JSON.parse(await res.text());
  assert.equal(body.error.code, "UNAUTHORIZED");
});

test("composed Worker custom namespace /me without v2 cookie and without legacy identity returns 401", async () => {
  const namespace = "/4ehhi-5deggi";
  const v2Env = makeEnv({
    ENVIRONMENT: "production",
    ADMIN_BASE_PATH: namespace,
    ADMIN_AUTH_V2: "1",
  });
  const res = await composedApp.request(
    `http://localhost${namespace}/me`,
    { headers: { Accept: "application/json" } },
    v2Env,
  );
  assert.equal(res.status, 401);
});
