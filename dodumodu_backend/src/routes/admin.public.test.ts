import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { adminRoute } from "./admin";
import type { Env } from "../env";

const env = {
  R2_BUCKET_NAME: "test-bucket",
  ENVIRONMENT: "sandbox",
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
  SITE_URL: "https://yoursite.com",
  MAX_ORDER_QUANTITY: "20",
  ALLOWED_ORIGINS: "https://yoursite.com",
  OPAY_BASE_URL: "https://sandboxapi.opaycheckout.com",
  ADMIN_OPERATORS: "",
  ADMIN_AUTH_V2: "0",
  ALLOW_TEST_IP: "",
  DATABASE_URL: "postgresql://test@localhost/test",
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
  RATE_LIMIT_KV: {} as unknown as KVNamespace,
} as unknown as Env;

function makeApp(namespace = "/admin") {
  const app = new Hono<{ Bindings: Env }>();
  app.route(namespace, adminRoute);
  return app;
}

/* ---- Public paths: no Access identity required ---- */

test("unauthenticated GET /admin/sign-in/ returns HTML login page (not JSON 401)", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin/sign-in/"), env);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("Content-Type")?.includes("text/html"));
  const body = await res.text();
  assert.ok(body.includes("<!doctype html>"));
  assert.ok(!body.includes('"error"'));
});

test("custom namespace sign-in rewrites both auth assets and serves them publicly", async () => {
  const namespace = "/4ehhi-5deggi";
  const customEnv = { ...env, ADMIN_BASE_PATH: namespace } as unknown as Env;
  const app = makeApp(namespace);
  const signIn = await app.fetch(
    new Request(`http://localhost${namespace}/sign-in`),
    customEnv,
  );
  assert.equal(signIn.status, 200);
  const html = await signIn.text();
  assert.match(html, new RegExp(`href="${namespace}/assets/auth\\.css"`));
  assert.match(html, new RegExp(`src="${namespace}/assets/auth\\.js"`));
  assert.ok(!html.includes("/admin/assets/"));

  const trailingSignIn = await app.fetch(
    new Request(`http://localhost${namespace}/sign-in/`),
    customEnv,
  );
  assert.equal(trailingSignIn.status, 200);
  assert.equal(await trailingSignIn.text(), html);

  const css = await app.fetch(
    new Request(`http://localhost${namespace}/assets/auth.css`),
    customEnv,
  );
  assert.equal(css.status, 200);
  assert.match(css.headers.get("Content-Type") ?? "", /^text\/css/);

  const js = await app.fetch(
    new Request(`http://localhost${namespace}/assets/auth.js`),
    customEnv,
  );
  assert.equal(js.status, 200);
  assert.match(js.headers.get("Content-Type") ?? "", /^text\/javascript/);

  const legacyCss = await app.fetch(
    new Request("http://localhost/admin/assets/auth.css"),
    customEnv,
  );
  assert.equal(legacyCss.status, 404);

  const legacyJs = await app.fetch(
    new Request("http://localhost/admin/assets/auth.js"),
    customEnv,
  );
  assert.equal(legacyJs.status, 404);
});

test("unauthenticated GET /admin/assets/auth.css returns CSS", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin/assets/auth.css"), env);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("Content-Type")?.includes("text/css"));
  const body = await res.text();
  assert.ok(body.length > 0);
  assert.ok(!body.includes('"error"'));
});

test("unauthenticated GET /admin/assets/auth.js returns JavaScript", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin/assets/auth.js"), env);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("Content-Type")?.includes("javascript"));
  const body = await res.text();
  assert.ok(body.length > 0);
  // Meaningful asset content (served minified, so local names are mangled):
  // the auth endpoint base, the QR import and the auth path — not an error response.
  assert.ok(body.includes('window.ADMIN_BASE_PATH||"/admin"'));
  assert.ok(body.includes("import(\"./qr-logo.mjs\")"), "the QR library loads on demand, not on every sign-in page view");
  assert.ok(!body.includes("import{makeQrElement"));
  assert.ok(body.includes("/auth`"));
});

test("unauthenticated GET /admin/assets/sessions.js returns JavaScript", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin/assets/sessions.js"), env);
  assert.equal(res.status, 200);
  assert.ok(!bodyIncludesError(await res.text()));
});

test("unauthenticated GET /admin/assets/devices.js returns JavaScript", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin/assets/devices.js"), env);
  assert.equal(res.status, 200);
  assert.ok(!bodyIncludesError(await res.text()));
});

test("unauthenticated GET /admin/assets/qr.js returns JavaScript", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin/assets/qr.js"), env);
  assert.equal(res.status, 200);
  assert.ok(!bodyIncludesError(await res.text()));
});

test("unauthenticated GET /admin/assets/qr-logo.mjs returns JavaScript", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin/assets/qr-logo.mjs"), env);
  assert.equal(res.status, 200);
  assert.ok(!bodyIncludesError(await res.text()));
});

/* ---- Protected paths: still require Access identity ---- */

test("unauthenticated GET /admin/ returns JSON 401, not HTML", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin/"), env);
  assert.equal(res.status, 401);
  const body = await res.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "UNAUTHORIZED");
  assert.equal(body.error.message, "Sign in to use the admin");
});

test("unauthenticated GET /admin returns JSON 401", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin"), env);
  assert.equal(res.status, 401);
});

test("unauthenticated GET /admin/sessions returns JSON 401", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin/sessions"), env);
  assert.equal(res.status, 401);
});

test("unauthenticated GET /admin/devices returns JSON 401", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/admin/devices"), env);
  assert.equal(res.status, 401);
});

/* ---- Valid Access identity reaches protected routes ---- */

test("GET /admin/ with cf-access-authenticated-user-email returns console HTML", async () => {
  const app = makeApp();
  const headers = new Headers({ "cf-access-authenticated-user-email": "admin@example.com" });
  const res = await app.fetch(new Request("http://localhost/admin/", { headers }), env);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("Content-Type")?.includes("text/html"));
});

test("GET /admin/devices with cf-access-authenticated-user-email returns admin page", async () => {
  const app = makeApp();
  const headers = new Headers({ "cf-access-authenticated-user-email": "admin@example.com" });
  const res = await app.fetch(new Request("http://localhost/admin/devices", { headers }), env);
  assert.equal(res.status, 200);
});

/* ---- Missing/invalid identity cannot grant access ---- */

test("GET /admin/ with blank Access header returns 401", async () => {
  const app = makeApp();
  const headers = new Headers({ "cf-access-authenticated-user-email": "" });
  const res = await app.fetch(new Request("http://localhost/admin/", { headers }), env);
  assert.equal(res.status, 401);
});

/* ---- DEPLOY_TRIGGER_SECRET behavior unchanged ---- */

test("GET /admin/ with valid DEPLOY_TRIGGER_SECRET bypasses Access auth", async () => {
  const secretEnv = { ...env, DEPLOY_TRIGGER_SECRET: "ci-secret-123" } as unknown as Env;
  const app = makeApp();
  const headers = new Headers({ authorization: "Bearer ci-secret-123" });
  const res = await app.fetch(new Request("http://localhost/admin/", { headers }), secretEnv);
  assert.notEqual(res.status, 401);
});

test("GET /admin/ with wrong DEPLOY_TRIGGER_SECRET returns 401", async () => {
  const secretEnv = { ...env, DEPLOY_TRIGGER_SECRET: "ci-secret-123" } as unknown as Env;
  const app = makeApp();
  const headers = new Headers({ authorization: "Bearer wrong-secret" });
  const res = await app.fetch(new Request("http://localhost/admin/", { headers }), secretEnv);
  assert.equal(res.status, 401);
});

function bodyIncludesError(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.error !== "undefined";
  } catch {
    return false;
  }
}
test("sign-in assets are cacheable: ETag + short freshness window, and a repeat visit gets a 304 with no body", async () => {
  const app = makeApp();
  for (const path of ["auth.js", "auth.css", "qr-logo.mjs", "qr.js"]) {
    const first = await app.fetch(new Request(`http://localhost/admin/assets/${path}`), env);
    assert.equal(first.status, 200, path);
    const etag = first.headers.get("ETag");
    assert.ok(etag, `${path} has an ETag`);
    assert.match(first.headers.get("Cache-Control") ?? "", /max-age=\d+/, `${path} is cacheable`);
    assert.doesNotMatch(first.headers.get("Cache-Control") ?? "", /immutable/, `${path} has no content hash in its URL, so it must not be immutable`);
    const again = await app.fetch(new Request(`http://localhost/admin/assets/${path}`, { headers: { "If-None-Match": etag! } }), env);
    assert.equal(again.status, 304, `${path} revalidates with a 304`);
    assert.equal((await again.text()).length, 0, `${path} 304 has no body`);
  }
  // the page itself is never cached: it carries per-request state
  const page = await app.fetch(new Request("http://localhost/admin/sign-in/"), env);
  assert.match(page.headers.get("Cache-Control") ?? "", /no-store/);
});
