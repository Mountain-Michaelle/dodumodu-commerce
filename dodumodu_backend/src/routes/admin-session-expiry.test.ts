// Regression tests for session-expiry recovery across public and protected routes.
//
// Covers the fix for: an expired/revoked/malformed __Host-sid cookie must not
// block public authentication pages or assets, and protected pages/APIs must
// recover cleanly (HTML redirect → sign-in, JSON 401 → client redirect).
//
// Database-backed tests use the local PostgreSQL test database (DATABASE_URL).
// Non-database tests use the fake env and exercise the dispatcher/routing layer
// without touching the DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { app as composedApp } from "../app";
import type { Env } from "../env";
import { registerDbDriver } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, q1, sql } from "../auth/sql";
import { tokenHashHex } from "../auth/keys";
import type { Db } from "../db";

// Stub DB driver for tests that route through loadSession without a real DB.
// Returns empty results so lookupSession resolves to null (no session found).
const stubDriver = (() => {
  const stub = { execute: async () => ({ rows: [] }) } as unknown as Db;
  return (_url: string) => stub;
})();
registerDbDriver(stubDriver);

const databaseUrl = process.env.DATABASE_URL;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "fake://ns-test",
    ENVIRONMENT: "sandbox",
    ADMIN_BASE_PATH: "/admin",
    ADMIN_AUTH_V2: "1",
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
    SITE_URL: "https://yoursite.com",
    MAX_ORDER_QUANTITY: "20",
    ALLOWED_ORIGINS: "https://yoursite.com",
    OPAY_BASE_URL: "https://sandboxapi.opaycheckout.com",
    ADMIN_OPERATORS: "",
    ALLOW_TEST_IP: "",
    OTP_KEY: "",
    THROTTLE_KEY: "",
    TOTP_ENC_KEY: "",
    RESEND_API_KEY: "",
    TURNSTILE_SECRET_KEY: "",
    RECONCILE_CRON_SECRET: "",
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

async function fetchWithEnv(url: string, cookie: string | null, env: Env): Promise<Response> {
  const headers: HeadersInit = {};
  if (cookie !== null) headers["Cookie"] = cookie;
  return composedApp.fetch(new Request(url, { headers }), env);
}

/* ------------------------------------------------------------------ */
/* Non-database tests: dispatcher/routing layer with fake env         */
/* ------------------------------------------------------------------ */

test("public sign-in page is 200 with no session cookie", async () => {
  const env = makeEnv();
  const res = await fetchWithEnv("http://localhost/admin/sign-in/", null, env);
  assert.equal(res.status, 200, "sign-in page must be public");
  assert.ok(
    (await res.text()).includes("<!doctype html>"),
    "sign-in page must return HTML",
  );
});

test("public sign-in page is 200 with an expired session cookie", async () => {
  const env = makeEnv();
  const res = await fetchWithEnv(
    "http://localhost/admin/sign-in/",
    "__Host-sid=expired.stale.token",
    env,
  );
  assert.equal(res.status, 200, "sign-in page must be public even with expired cookie");
});

test("public sign-in page is 200 with a malformed session cookie", async () => {
  const env = makeEnv();
  const res = await fetchWithEnv(
    "http://localhost/admin/sign-in/",
    "__Host-sid=not-a-hex-token!!!",
    env,
  );
  assert.equal(res.status, 200, "sign-in page must be public even with malformed cookie");
});

test("public auth assets are 200 with no session cookie", async () => {
  const env = makeEnv();
  const res = await fetchWithEnv(
    "http://localhost/admin/assets/auth.js",
    null,
    env,
  );
  assert.equal(res.status, 200, "auth.js must be public");
});

test("public auth assets are 200 with an expired session cookie", async () => {
  const env = makeEnv();
  const res = await fetchWithEnv(
    "http://localhost/admin/assets/auth.js",
    "__Host-sid=expired.stale.token",
    env,
  );
  assert.equal(res.status, 200, "auth.js must be public even with expired cookie");
});

test("public auth assets are 200 with a malformed session cookie", async () => {
  const env = makeEnv();
  const res = await fetchWithEnv(
    "http://localhost/admin/assets/auth.js",
    "__Host-sid=not-a-hex-token!!!",
    env,
  );
  assert.equal(res.status, 200, "auth.js must be public even with malformed cookie");
});

test("console root redirects to sign-in with no session (V2 enabled)", async () => {
  const env = makeEnv({ ADMIN_AUTH_V2: "1" });
  const res = await fetchWithEnv("http://localhost/admin/", null, env);
  assert.equal(res.status, 302, "console root without session must redirect");
  assert.equal(res.headers.get("location"), "/admin/sign-in/");
});

test("console root redirects to sign-in with an invalid session cookie", async () => {
  const env = makeEnv({ ADMIN_AUTH_V2: "1" });
  const res = await fetchWithEnv(
    "http://localhost/admin/",
    "__Host-sid=garbage.token",
    env,
  );
  assert.equal(res.status, 302, "console root with invalid session must redirect");
  assert.equal(res.headers.get("location"), "/admin/sign-in/");
});

/* ------------------------------------------------------------------ */
/* Database-backed tests: real session states                         */
/* ------------------------------------------------------------------ */

async function createAdminSession(
  db: Db,
  email: string,
  opts: {
    expired?: boolean;
    revoked?: boolean;
    sessionVersionMismatch?: boolean;
  } = {},
): Promise<string> {
  await q(db, sql`
    INSERT INTO aa_users (id, email, role, is_active, session_version)
    VALUES (gen_random_uuid(), ${email}, 'admin', true, 1)
    ON CONFLICT DO NOTHING
  `);
  const userId = (await q(db, sql`SELECT id FROM aa_users WHERE email = ${email}`))[0].id;

  // Admin sessions require an active device (lookupSession enforces this).
  const deviceTokenHash = await tokenHashHex(`regression-device-token-${Date.now()}-${Math.random()}`);
  const deviceRow = await q1(db, sql`
    INSERT INTO aa_admin_devices (token_hash, user_id, status, created_via, expires_at, last_seen_at)
    VALUES (decode(${deviceTokenHash}, 'hex'), ${userId}, 'active', 'first_login', now() + interval '72 hours', now())
    RETURNING id
  `);
  const deviceId = deviceRow!.id;

  // Revoke any existing sessions for this user first.
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id = ${userId}`);

  const sessionToken = `regression-${opts.expired ? "expired" : opts.revoked ? "revoked" : opts.sessionVersionMismatch ? "mismatch" : "valid"}-${Date.now()}`;
  const idHash = await tokenHashHex(sessionToken);

  const expiresAt = opts.expired
    ? "now() - interval '1 hour'"
    : "now() + interval '1 hour'";

  let sessionVersion = 1;
  if (opts.sessionVersionMismatch) sessionVersion = 99; // differs from user's version (1)

  await q(db, sql`
    INSERT INTO aa_sessions (id_hash, user_id, session_version, absolute_expires_at, ip, ua, tier, login_via, device_id)
    VALUES (decode(${idHash}, 'hex'), ${userId}, ${sessionVersion}, ${sql.raw(expiresAt)}, '10.0.0.1', 'test', 'normal', 'email', ${deviceId})
  `);

  if (opts.revoked) {
    await q(db, sql`DELETE FROM aa_sessions WHERE id_hash = decode(${idHash}, 'hex')`);
  }

  return sessionToken;
}

async function cleanupAdminUser(db: Db, email: string) {
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM aa_users WHERE email = ${email})`);
  await q(db, sql`DELETE FROM aa_admin_devices WHERE user_id IN (SELECT id FROM aa_users WHERE email = ${email})`);
  await q(db, sql`DELETE FROM aa_users WHERE email = ${email}`);
}

test("protected console root redirects to sign-in with expired session (DB-backed)", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanupAdminUser(db, `regression-expired-${Date.now()}@example.com`); await closePools(); });

  const email = `regression-expired-${Date.now()}@example.com`;
  const sessionToken = await createAdminSession(db, email, { expired: true });

  const env = makeEnv({ ADMIN_AUTH_V2: "1", DATABASE_URL: databaseUrl! });
  const res = await fetchWithEnv(
    "http://localhost/admin/",
    `__Host-sid=${sessionToken}`,
    env,
  );
  assert.equal(res.status, 302, "expired session on protected page must redirect to sign-in");
  assert.equal(res.headers.get("location"), "/admin/sign-in/");
});

test("protected console root redirects to sign-in with revoked session (DB-backed)", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanupAdminUser(db, `regression-revoked-${Date.now()}@example.com`); await closePools(); });

  const email = `regression-revoked-${Date.now()}@example.com`;
  const sessionToken = await createAdminSession(db, email, { revoked: true });

  const env = makeEnv({ ADMIN_AUTH_V2: "1", DATABASE_URL: databaseUrl! });
  const res = await fetchWithEnv(
    "http://localhost/admin/",
    `__Host-sid=${sessionToken}`,
    env,
  );
  assert.equal(res.status, 302, "revoked session on protected page must redirect to sign-in");
  assert.equal(res.headers.get("location"), "/admin/sign-in/");
});

test("protected console root redirects to sign-in with session-version mismatch (DB-backed)", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanupAdminUser(db, `regression-mismatch-${Date.now()}@example.com`); await closePools(); });

  const email = `regression-mismatch-${Date.now()}@example.com`;
  const sessionToken = await createAdminSession(db, email, { sessionVersionMismatch: true });

  const env = makeEnv({ ADMIN_AUTH_V2: "1", DATABASE_URL: databaseUrl! });
  const res = await fetchWithEnv(
    "http://localhost/admin/",
    `__Host-sid=${sessionToken}`,
    env,
  );
  assert.equal(res.status, 302, "session-version mismatch on protected page must redirect to sign-in");
  assert.equal(res.headers.get("location"), "/admin/sign-in/");
});

test("protected console root serves HTML with valid session (DB-backed)", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanupAdminUser(db, `regression-valid-${Date.now()}@example.com`); await closePools(); });

  const email = `regression-valid-${Date.now()}@example.com`;
  const sessionToken = await createAdminSession(db, email, {});

  const env = makeEnv({ ADMIN_AUTH_V2: "1", DATABASE_URL: databaseUrl! });
  const res = await fetchWithEnv(
    "http://localhost/admin/",
    `__Host-sid=${sessionToken}`,
    env,
  );
  assert.equal(res.status, 200, "valid session on protected page must serve HTML");
  assert.ok((await res.text()).includes("<!doctype html>"));
});

/* ------------------------------------------------------------------ */
/* Custom namespace tests                                             */
/* ------------------------------------------------------------------ */

test("custom namespace sign-in page is 200 with expired session cookie", async () => {
  const namespace = "/4ehhi-5deggi";
  const env = makeEnv({
    ENVIRONMENT: "production",
    ADMIN_BASE_PATH: namespace,
    ADMIN_AUTH_V2: "1",
  });
  const res = await fetchWithEnv(
    `http://localhost${namespace}/sign-in/`,
    "__Host-sid=expired.stale.token",
    env,
  );
  assert.equal(res.status, 200, "custom namespace sign-in page must be public with expired cookie");
});

test("custom namespace console root redirects to sign-in with no session", async () => {
  const namespace = "/4ehhi-5deggi";
  const env = makeEnv({
    ENVIRONMENT: "production",
    ADMIN_BASE_PATH: namespace,
    ADMIN_AUTH_V2: "1",
  });
  const res = await fetchWithEnv(`http://localhost${namespace}/`, null, env);
  assert.equal(res.status, 302, "custom namespace console root without session must redirect");
  assert.equal(res.headers.get("location"), `${namespace}/sign-in/`);
});

test("custom namespace sign-in page is 200 with malformed cookie", async () => {
  const namespace = "/4ehhi-5deggi";
  const env = makeEnv({
    ENVIRONMENT: "production",
    ADMIN_BASE_PATH: namespace,
    ADMIN_AUTH_V2: "1",
  });
  const res = await fetchWithEnv(
    `http://localhost${namespace}/sign-in/`,
    "__Host-sid=not-a-hex-token!!!",
    env,
  );
  assert.equal(res.status, 200, "custom namespace sign-in page must be public with malformed cookie");
});

/* ------------------------------------------------------------------ */
/* 401 vs 403 distinction                                             */
/* ------------------------------------------------------------------ */

test("only a lost session (401) sends the page to sign-in; 403 never does, in the shared helper and every page", async () => {
  const fs = await import("node:fs/promises");
  const helper = await fs.readFile("src/auth-ui/admin-ui.js", "utf8");
  assert.ok(helper.includes("if (res.status === 401)"), "admin-ui.js must redirect on 401");
  assert.ok(!/status === 401 \|\| [a-z.]*status === 403/.test(helper), "admin-ui.js must not redirect on 403");
  for (const f of ["sessions.js", "devices.js"]) {
    const js = await fs.readFile(`src/auth-ui/${f}`, "utf8");
    assert.ok(!/status === 401 \|\| [a-z.]*status === 403/.test(js), `${f} must not redirect on 403`);
    assert.ok(!/location\.href\s*=/.test(js.replace(/\/\/.*$/gm, "")), `${f} sends people to sign-in only through the helper`);
  }
});

/* ------------------------------------------------------------------ */
/* Fresh login replaces stale state (conceptual)                      */
/* ------------------------------------------------------------------ */

test("expired cookie does not prevent fresh login page from loading", async () => {
  const env = makeEnv();
  const res = await fetchWithEnv(
    "http://localhost/admin/sign-in/",
    "__Host-sid=expired.token.from.previous.session",
    env,
  );
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Sign in"), "sign-in form must render");
  assert.ok(html.includes("/admin/assets/auth.js"), "sign-in page must reference auth assets");
  assert.ok(html.includes("/admin/assets/auth.css"), "sign-in page must reference auth css");
});

test("V1 Cloudflare Access authentication unchanged (public paths exempt)", async () => {
  const env = makeEnv({ ADMIN_AUTH_V2: "0" });
  const res = await fetchWithEnv("http://localhost/admin/sign-in/", null, env);
  assert.equal(res.status, 200, "sign-in page must be public when V2 is off");
});

test("V1 Cloudflare Access protected paths still require identity", async () => {
  const env = makeEnv({ ADMIN_AUTH_V2: "0" });
  const res = await fetchWithEnv("http://localhost/admin/", null, env);
  assert.equal(res.status, 401, "V1 protected route without Access identity must be 401");
});