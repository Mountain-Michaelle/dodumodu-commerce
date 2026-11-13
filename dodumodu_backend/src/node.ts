// Local Node composition root — `npm run dev`. The same app, the same routes,
// the same services and repositories as the Worker; only the runtime pieces
// differ: a TCP Postgres driver instead of Neon's HTTP one, a directory
// instead of R2, a Map instead of KV, and the built site served from the same
// port so the frontend needs no API_BASE and no CORS.
//
// Nothing in src/app.ts, src/routes/, src/services/ or src/data/ knows this
// file exists — that is the point. Production runs src/index.ts instead, with
// the real bindings, and needs no change here.
import { isNonProduction } from "./config/environment";
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "./app";
import { registerDbDriver } from "./db";
import { closePools, pgDriver } from "./dbDrivers/pg";
import type { Env } from "./env";
import { backendRoot, loadRootEnv, repoRoot } from "./node/envFile";
import { localBucket, memoryKV } from "./node/shims";
import { mountMedia } from "./node/static";
import { resolveMediaPath, contentTypeFor } from "./node/mediaPath";

const envFileLoaded = loadRootEnv();

const port = Number(process.env.PORT ?? 8787);
const mediaRoot = resolve(backendRoot, process.env.MEDIA_DIR ?? ".media");
const siteDist = join(repoRoot, "dodumodu_site", "dist");

// The one thing that cannot have a sensible default: a database URL is either
// right or wrong, and guessing would fail later and further away.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  console.error("  Add it to the repository-root .env (see .env.example), or pass it in:");
  console.error("    DATABASE_URL=postgresql://user@localhost:5432/dodumodu npm run dev");
  process.exit(1);
}

// Defaults mirror wrangler.toml [vars] so local behaviour matches a deployed
// Worker with default configuration; .env overrides any of them.
const env: Env = {
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME ?? "skincare-media",
  ENVIRONMENT: process.env.ENVIRONMENT === "production" ? "production" : "sandbox",
  RATE_LIMIT_API_PER_MINUTE: process.env.RATE_LIMIT_API_PER_MINUTE ?? "20",
  ANALYTICS_IP_HMAC_SECRET: process.env.ANALYTICS_IP_HMAC_SECRET ?? "",
  ANALYTICS_IP_HMAC_VERSION: process.env.ANALYTICS_IP_HMAC_VERSION ?? "1",
  ANALYTICS_WARMUP_ENABLED: process.env.ANALYTICS_WARMUP_ENABLED ?? "false",
  ASSIGNMENT_MODE_ENABLED: process.env.ASSIGNMENT_MODE_ENABLED ?? "false",
  RATE_LIMIT_ORDER_PER_PHONE_PER_HOUR: process.env.RATE_LIMIT_ORDER_PER_PHONE_PER_HOUR ?? "5",
  // Admin limits are separate keyspaces from the customer ones. 600 reads is a
  // runaway-script backstop, not a speed limit: the console legitimately issues a
  // dozen requests per interaction. Writes are far tighter because they are the
  // ones that change money and content.
  RATE_LIMIT_ADMIN_PER_MINUTE: process.env.RATE_LIMIT_ADMIN_PER_MINUTE ?? "600",
  RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: process.env.RATE_LIMIT_ADMIN_WRITES_PER_MINUTE ?? "60",

  // Image pipeline. Every value here has the same default in imageConfig.ts, so a
  // missing variable degrades to a working configuration rather than a broken one.
  IMAGE_MODE: process.env.IMAGE_MODE ?? "derivative",
  MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES ?? "10485760",
  MAX_IMAGE_DIMENSION: process.env.MAX_IMAGE_DIMENSION ?? "12000",
  IMAGE_KEY_PREFIX: process.env.IMAGE_KEY_PREFIX ?? "uploads",
  IMAGE_WIDTHS_HERO: process.env.IMAGE_WIDTHS_HERO ?? "480,768,1200",
  IMAGE_WIDTHS_GALLERY: process.env.IMAGE_WIDTHS_GALLERY ?? "320,640,960",
  IMAGE_WIDTHS_TESTIMONIAL: process.env.IMAGE_WIDTHS_TESTIMONIAL ?? "320,640",
  IMAGE_WIDTHS_THUMBNAIL: process.env.IMAGE_WIDTHS_THUMBNAIL ?? "160,320",
  IMAGE_QUALITY_HERO: process.env.IMAGE_QUALITY_HERO ?? "80",
  IMAGE_QUALITY_GALLERY: process.env.IMAGE_QUALITY_GALLERY ?? "75",
  IMAGE_QUALITY_TESTIMONIAL: process.env.IMAGE_QUALITY_TESTIMONIAL ?? "70",
  IMAGE_QUALITY_THUMBNAIL: process.env.IMAGE_QUALITY_THUMBNAIL ?? "70",
  CATALOG_EDGE_TTL: process.env.CATALOG_EDGE_TTL ?? "300",
  CATALOG_EDGE_SWR: process.env.CATALOG_EDGE_SWR ?? "3600",
  // Locally the dev server serves /media itself. In production this is the R2
  // custom domain - never a Worker route.
  IMAGE_DELIVERY_BASE: process.env.IMAGE_DELIVERY_BASE ?? "/media",
  PAGES_DEPLOY_HOOK: process.env.PAGES_DEPLOY_HOOK ?? "",
  // Public origin of the deployed Worker; CI reaches build-status endpoints here.
  WORKER_URL: process.env.WORKER_URL ?? "",
  // Build-deploy secrets. Empty locally; publish degrades gracefully until set.
  DEPLOY_TRIGGER_SECRET: process.env.DEPLOY_TRIGGER_SECRET ?? "",
  GITHUB_DEPLOY_TOKEN: process.env.GITHUB_DEPLOY_TOKEN ?? "",
  // The PUBLIC storefront origin. Empty locally, which makes verification report
  // "unconfigured" and the state fall back to what was actually requested - rather
  // than checking a URL that does not exist and reporting a confident answer.
  SITE_URL: process.env.SITE_URL ?? "",
  MAX_ORDER_QUANTITY: process.env.MAX_ORDER_QUANTITY ?? "20",
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? "",
  OPAY_BASE_URL: process.env.OPAY_BASE_URL ?? "",
  ADMIN_OPERATORS: process.env.ADMIN_OPERATORS ?? "",

  // Abuse layer. Every one of these defaults to the SAFE value: shadow means
  // "evaluate and log, refuse nobody", so a deployment that sets none of them
  // observes rather than blocks. That default is deliberate and is why the local
  // Env must carry them - without this, RL_AUTO_BLOCK=on in .env would be
  // silently ignored here while working on the Worker, which is the worst kind of
  // difference between the two runtimes.
  RL_MODE: process.env.RL_MODE ?? "shadow",
  RL_AUTO_BLOCK: process.env.RL_AUTO_BLOCK ?? "shadow",
  RL_V2_ENABLED: process.env.RL_V2_ENABLED ?? "off",
  RL_VELOCITY_WINDOW_SECONDS: process.env.RL_VELOCITY_WINDOW_SECONDS ?? "60",
  RL_VELOCITY_BLOCK_SECONDS: process.env.RL_VELOCITY_BLOCK_SECONDS ?? "600",
  RL_V1_MIN_ORDERS: process.env.RL_V1_MIN_ORDERS ?? "4",
  RL_V1_MIN_PHONES: process.env.RL_V1_MIN_PHONES ?? "3",
  RL_V2_MIN_ORDERS: process.env.RL_V2_MIN_ORDERS ?? "10",
  RL_V2_MIN_PHONES: process.env.RL_V2_MIN_PHONES ?? "4",
  RL_V2_DEVICE_RATIO: process.env.RL_V2_DEVICE_RATIO ?? "0.7",
  RL_WINDOW_SECONDS: process.env.RL_WINDOW_SECONDS ?? "900",
  RL_BLOCK_SECONDS: process.env.RL_BLOCK_SECONDS ?? "1800",
  RL_ABUSE_IP_POSTS: process.env.RL_ABUSE_IP_POSTS ?? "120",
  RL_ABUSE_DISTINCT_PHONES: process.env.RL_ABUSE_DISTINCT_PHONES ?? "40",
  RL_ABUSE_FAILURES: process.env.RL_ABUSE_FAILURES ?? "60",
  RL_ABUSE_SUCCESS_FLOOR: process.env.RL_ABUSE_SUCCESS_FLOOR ?? "3",
  RL_IP_ALLOWLIST: process.env.RL_IP_ALLOWLIST ?? "",
  RL_PHONE_MAX_OPEN: process.env.RL_PHONE_MAX_OPEN ?? "3",
  SUPPORT_WHATSAPP_URL: process.env.SUPPORT_WHATSAPP_URL ?? "",

  DATABASE_URL: databaseUrl,
  OPAY_PUBLIC_KEY: process.env.OPAY_PUBLIC_KEY ?? "",
  OPAY_SECRET_KEY: process.env.OPAY_SECRET_KEY ?? "",
  OPAY_MERCHANT_ID: process.env.OPAY_MERCHANT_ID ?? "",
  OPAY_WEBHOOK_SECRET: process.env.OPAY_WEBHOOK_SECRET ?? "",
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY ?? "",
  RECONCILE_CRON_SECRET: process.env.RECONCILE_CRON_SECRET ?? "",

  // admin-auth v2 (feature flag off by default; secrets only needed when on).
  ADMIN_AUTH_V2: process.env.ADMIN_AUTH_V2 ?? "0",
  ALLOW_TEST_IP: process.env.ALLOW_TEST_IP ?? "",
  OTP_KEY: process.env.OTP_KEY ?? "",
  THROTTLE_KEY: process.env.THROTTLE_KEY ?? "",
  TOTP_ENC_KEY: process.env.TOTP_ENC_KEY ?? "",
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
  TURNSTILE_SECRET: process.env.TURNSTILE_SECRET ?? "",
  AUTH_FROM_EMAIL: process.env.AUTH_FROM_EMAIL ?? "auth@example.com",
  ORDER_BACKUP_EMAIL: process.env.ORDER_BACKUP_EMAIL ?? "",
  ADMIN_BASE_PATH: process.env.ADMIN_BASE_PATH ?? "/admin",

  // The only local-only values in the whole Env: real bindings on the Worker.
  MEDIA_BUCKET: localBucket(mediaRoot),
  REFERRED_SLACK_WEBHOOK_URL: process.env.REFERRED_SLACK_WEBHOOK_URL ?? "",
  RATE_LIMIT_KV: memoryKV(),
};

registerDbDriver(pgDriver);

// Guarded admin pages are served by src/app.ts under the configured namespace;
// nothing to mount here for local Node.

mountMedia(app, mediaRoot);

// --- Static-file middleware served BEFORE app routes -----------------------
// app.ts registers `app.get("/:slug", ...)` which matches every single-segment
// path (robots.txt, sitemap.xml, *.css, *.js). That route runs before
// mountStatic's catch-all `*`, so static assets would 404. Serve them here
// first so anything that resolves to a real file under siteDist is handled
// before the app's own routes are consulted. If no static file matches,
// `await next()` lets the request fall through to the app's routes.
if (existsSync(siteDist)) {
  app.use("*", async (c, next) => {
    const requested = c.req.path;
    // Paths owned by other mounts are never served as static files.
    if (
      requested === "/health" ||
      requested.startsWith("/media/") ||
      requested === "/admin" ||
      requested.startsWith("/admin/") ||
      requested.startsWith("/auth")
    ) {
      return await next();
    }
    const relative = requested.replace(/^\/+/, "");
    const candidates = relative === "" || relative.endsWith("/")
      ? [`${relative}index.html`]
      : [relative, `${relative}/index.html`];
    for (const candidate of candidates) {
      const file = resolveMediaPath(siteDist, candidate);
      if (!file) continue;
      const buffer = readFileSync(file);
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const cacheControl = /\.[a-f0-9]{8}\.min\.(css|js)$/.test(requested)
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      return c.body(bytes, 200, {
        "Content-Type": contentTypeFor(file),
        "Cache-Control": cacheControl,
        "X-Content-Type-Options": "nosniff",
      });
    }
    await next();
  });
}

// Locally there is no Cloudflare Access in front of /admin/*, so every admin
// request would answer 401 and the admin page would never load. The local
// runtime supplies the identity header Access would supply, and a loopback
// address for the per-IP rate limiter. This is local-only by construction: the
// file is not in the production bundle, and in production the real Access
// policy is what authorizes an admin — not a header this app can set.
const LOCAL_ADMIN_EMAIL = process.env.LOCAL_ADMIN_EMAIL ?? "admin@dodumodu.local";

const fetchWithLocalIdentity: typeof app.fetch = (request) => {
  const headers = new Headers(request.headers);
  // Local-only by enforcement, not just by comment: with a production (or unknown) ENVIRONMENT the identity
  // is never injected and any identity header a client sent is dropped, so this entry point cannot be an
  // open admin door if it is ever started with the wrong configuration.
  if (isNonProduction(env.ENVIRONMENT)) headers.set("cf-access-authenticated-user-email", LOCAL_ADMIN_EMAIL);
  else headers.delete("cf-access-authenticated-user-email");
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", "127.0.0.1");
  return app.fetch(new Request(request, { headers }), env);
};

const server = serve({ fetch: fetchWithLocalIdentity, port }, (info) => {
  const lines = [
    "",
    `  Skincare store — local development (${env.ENVIRONMENT})`,
    "",
    `    site      http://localhost:${info.port}/`,
    `    admin     http://localhost:${info.port}/admin/`,
    `    api       http://localhost:${info.port}/health`,
    `    media     ${mediaRoot}`,
    "",
    `    env file  ${envFileLoaded ? "root .env" : "process environment only"}`,
    `    database  ${databaseUrl.replace(/:[^:@/]+@/, ":***@")}`,
    "",
  ];
  if (!env.ENVIRONMENT || env.ENVIRONMENT === "sandbox") {
    lines.push("  Pay Now needs OPay sandbox credentials in .env; pay on delivery works offline.");
  }
  if (!env.TURNSTILE_SECRET_KEY) {
    lines.push("  Turnstile is off locally (no secret set) — orders skip bot verification.");
  }
  if (!existsSync(siteDist)) {
    lines.push(`  No site build found at ${siteDist} — run "npm run build" in dodumodu_site.`);
  }
  if (env.ENVIRONMENT === "sandbox") {
    lines.push(`  /admin is open locally as ${LOCAL_ADMIN_EMAIL} (no Cloudflare Access in front of it).`);
  }
  console.log(lines.join("\n"));
  console.log(`  admin-auth v2  ${env.ADMIN_AUTH_V2 === "1" ? "ON" : "OFF"}`);
});

// A taken port is the one startup failure a developer hits for real - a dev
// server left running in another terminal, usually. Node's default for it is a
// stack trace and a process that lingers, so say what happened and how to fix
// it. This is the only place the local entry can fail to start.
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      [
        "",
        `  Port ${port} is already in use, so this server did not start.`,
        "",
        "  Most likely another dev server is still running. To find and stop it:",
        `    Get-NetTCPConnection -LocalPort ${port} -State Listen |`,
        `      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`,
        "",
        `  Or give this one a different port by setting PORT in the repository-root .env.`,
        "",
      ].join("\n"),
    );
  } else {
    console.error(error);
  }
  // Exit rather than linger: under `tsx watch` a crashed-but-alive parent keeps
  // the terminal occupied and re-runs on the next unrelated file save.
  process.exit(1);
});

// Close the pool on Ctrl+C so the process exits immediately instead of waiting
// out the connection timeout.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void closePools().finally(() => process.exit(0));
  });
}
