// The application itself — every route, with no runtime in it. This module is
// imported by BOTH entry points (src/index.ts for the Worker, src/node.ts for
// local Node), so there is exactly one copy of the routing, the middleware and
// the services in the repository, and switching environments switches the
// entry point and the config — never this file.
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { apiRateLimit, adminRateLimit, adminWriteRateLimit } from "./middleware/rateLimit";
import { catalogRoute } from "./routes/catalog";
import { ordersRoute } from "./routes/orders";
import { paymentsRoute } from "./routes/payments";
import { adminRoute } from "./routes/admin";
import { authRoute as adminAuthRoute, adminRoute as adminAuthAdminRoute } from "./auth/routes";
import { adminBasePath, isLegacyAdminPath, rewriteAdminHtml } from "./config/adminBase";
import { loadSession } from "./auth/middleware";
import { adminAuthEnabled } from "./auth/config";
import { ADMIN_CONSOLE_HTML } from "./generated/adminPages";
import { getSidToken } from "./auth/ctx";
import { monthlyKpiSnapshotsRoute } from "./routes/monthlyKpiSnapshots";
import { visitorAnalyticsRoute } from "./routes/visitorAnalytics";
import { visitorRetentionRoute } from "./routes/visitorRetention";
import * as site from "./generated/site";
import { robotsTxt, sitemapXml, THANK_YOU_HTML } from "./staticAssets";

/**
 * The CORS allowlist, from ALLOWED_ORIGINS (comma separated). Scoped to exact
 * origins — never '*' — because the API takes real customer details and hands
 * back order state. An entry may be a wildcard subdomain ("*.pages.dev") for
 * the Cloudflare Pages preview domain; everything else must match exactly, so a
 * new origin has to be added here on purpose rather than inherited.
 */
export function isOriginAllowed(origin: string, allowedOrigins: string | undefined): boolean {
  if (!origin) return false;
  const entries = (allowedOrigins ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // "*.pages.dev" -> ".pages.dev"
      return origin.length > suffix.length && origin.endsWith(suffix);
    }
    return origin === entry;
  });
}

export const app = new Hono<{ Bindings: Env }>();

// §3 Phase 0, step 8, option (b): if Pages and the Worker end up on different
// subdomains, CORS must be scoped to the exact Pages origin — never '*'.
// The allowlist itself is configuration (ALLOWED_ORIGINS): local dev lists
// http://localhost, production lists the real domain. If you put both on the
// same domain via a Worker route instead, this middleware simply passes.
app.use("*", cors({
  origin: (origin, c) => (isOriginAllowed(origin, c.env?.ALLOWED_ORIGINS) ? origin : ""),
  allowMethods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"],
}));

app.get("/health", (c) => c.json({ ok: true }));

// Both public page views are anonymous traffic that reaches the database, so
// both are limited. A snapshot cache in front of /published is what makes that
// traffic cheap, not what makes it ignorable.
app.use("/page-data/*", apiRateLimit);
app.use("/published/*", apiRateLimit);
app.route("/", catalogRoute);

// /create-order is deliberately NOT wrapped in apiRateLimit.
//
// That limiter keys on `api:${ip}` and reads ONLY the request header, so it
// cannot see the idempotency key and cannot tell a retry from a flood. It
// could therefore refuse a legitimate order, and - worse - refuse a legitimate
// RETRY of an order already created, which is exactly what happens when a
// customer's connection drops mid-checkout. It also shared its bucket with
// /page-data, so page reads could exhaust a customer's order budget.
//
// Order-form abuse is handled by orderGuard (src/middleware/orderGuard.ts),
// which checks idempotency FIRST and judges activity on correlated multi-signal
// evidence rather than a request count.
app.route("/", ordersRoute);

// Webhook + reconcile are authenticated by signature/shared secret, not the
// general per-IP limiter — OPay's own retry behavior and cron-job.org's fixed
// schedule shouldn't compete with customer traffic for the same bucket.
app.route("/", paymentsRoute);
app.route("/", monthlyKpiSnapshotsRoute);
app.route("/", visitorAnalyticsRoute);
app.route("/", visitorRetentionRoute);

// The admin console gets its OWN limits, not the customer ones.
  //
  // This replaces `app.use("/admin/*", apiRateLimit)`, which was a category error:
  // apiRateLimit keys on `api:${ip}` - the same bucket as /page-data,
  // /published and /create-order - and its default ceiling is 20/min. Locally
  // every request arrives as 127.0.0.1, so the console, the customer endpoints
  // and the tests all drew from a single 20-request budget, and the console
  // locked itself out after about seven searches.
  //
  // Reads are keyed on the operator email (an IP changes between networks, and a
  // shared office would pool several operators into one budget); writes get their
  // own, much tighter bucket. Order matters: the read limiter runs first, and the
  // write limiter needs the `adminEmail` identity that adminRoute sets.

// ---------------------------------------------------------------------------
// Admin namespace dispatch
//
// The active namespace is ADMIN_BASE_PATH (default /admin in development; an
// explicit, valid value is required in production). A single dispatcher runs
// for every request so that storefront paths such as product slugs are never
// stolen by an admin mount, legacy admin entry points (/admin, /admin-v2,
// /auth) return a generic 404, and only the active namespace reaches the admin
// surface. No DB/KV work happens here for public requests.
//
// The admin router is invoked by the dispatcher (not mounted with app.route,
// which would steal arbitrary single-segment paths such as product slugs).
app.use("*", adminNamespaceDispatcher);

async function adminNamespaceDispatcher(c: Context<{ Bindings: Env }>, next: Next) {
  const path = c.req.path;
  const active = adminBasePath({
    ENVIRONMENT: c.env.ENVIRONMENT,
    ADMIN_BASE_PATH: c.env.ADMIN_BASE_PATH,
  });

  if (active !== null && (path === active || path.startsWith(active + "/"))) {
    const rest = path === active ? "/" : path.slice(active.length);
    const url = "http://localhost" + rest + new URL(c.req.url).search;
    const raw = c.req.raw;
    const method = raw.method;
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: raw.headers,
      duplex: "half",
    };
    if (method !== "GET" && method !== "HEAD") {
      init.body = raw.body;
    }
    const subReq = new Request(url, init);

    // Admin rate limiting (read + write) runs only for the admin namespace,
    // never for storefront traffic.
    const readResponse = await adminRateLimit(c, async () => {});
    if (readResponse) return readResponse;

    if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      c.req.method !== "OPTIONS"
    ) {
      const writeResponse = await adminWriteRateLimit(c, async () => {});
      if (writeResponse) return writeResponse;
    }

    if (rest === "/auth" || rest.startsWith("/auth/")) {
      const authRest = rest === "/auth" ? "/" : rest.slice("/auth".length);
      return adminAuthRoute.request(authRest, init, c.env);
    }
    if (rest === "/admin-v2" || rest.startsWith("/admin-v2/")) {
      return adminAuthAdminRoute.fetch(subReq, c.env);
    }
    if (adminAuthEnabled(c.env as never) && (rest === "/" || rest === "")) {
      if (!getSidToken(c as never)) return c.text("Unauthorized", 401);
      const session = await loadSession(c as never);
      if (!session || session.role !== "admin") {
        return c.text("Unauthorized", 401);
      }
      const base = active;
      return c.html(rewriteAdminHtml(ADMIN_CONSOLE_HTML, base), 200);
    }
    return adminRoute.fetch(subReq, c.env);
  }

  if (isLegacyAdminPath(path)) return c.text("Not found", 404);
  return next();
}


// The storefront: serves the generated root HTML (ETag revalidation + strict
// CSP) and the content-hashed JS (immutable cache). Registered last so every
// API and admin route above wins its own path first; anything else falls
// through to mountStatic (local dev) or 404 (Worker).
app.get("/", (c) => c.html(site.INDEX_HTML));

// Root-level product pages: /:slug serves the prerendered snapshot captured at
// build time. No database read happens here — every page is pre-rendered into
// site.PRODUCTS by scripts/build-site.mjs and served from memory with ETag
// revalidation. Registered last so all API, admin, auth, health and media
// routes are matched first; anything not in PRODUCTS is a 404.
//
// Reserved routes (/health, /admin/*, /auth/*, /page-data/*, /published/*,
// /create-order, etc.) are mounted above and therefore never reach these
// handlers or the /:slug catch-all below.

// Customer JavaScript bundle — content-hashed, immutable cache.
app.get(site.APP_JS_PATH, (c) => {
  const immutable = /\.[a-f0-9]{8}\.min\.js$/.test(site.APP_JS_PATH);
  return c.body(site.APP_JS, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    ...(immutable ? { "Cache-Control": "public, max-age=31536000, immutable" } : { "Cache-Control": "no-cache" }),
  });
});

// Order confirmation page — served by the Worker in production (no Pages).
app.get("/thank-you.html", (c) => c.html(THANK_YOU_HTML, 200, { "Cache-Control": "no-cache" }));

// robots.txt — cacheable, sitemap URL filled from SITE_URL.
app.get("/robots.txt", (c) => c.text(robotsTxt(c.env.SITE_URL), 200, {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
}));

// sitemap.xml — lists flagship and every published product route.
app.get("/sitemap.xml", (c) => {
  const products = JSON.parse(site.PRODUCTS ?? "{}") as Record<string, unknown>;
  return c.text(sitemapXml(c.env.SITE_URL, products), 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
});

// Public media from R2 — safe key derivation, 404 on traversal/missing objects.
function mediaKeyFromPath(pathname: string): string | null {
  if (!pathname.startsWith("/media/")) return null;
  let key = pathname.slice("/media/".length);
  try {
    key = decodeURIComponent(key);
  } catch {
    return null;
  }
  if (!key || key.includes("\0") || key.includes("\\") || key.startsWith("/") || /^[a-zA-Z]:/.test(key)) return null;
  if (key.includes("..")) return null;
  return key;
}

app.get("/media/*", async (c) => {
  const key = mediaKeyFromPath(c.req.path);
  if (!key) return c.text("Not found", 404);
  const object = await c.env.MEDIA_BUCKET.get(key);
  if (!object) return c.text("Not found", 404);
  const headers: Record<string, string> = {};
  if (object.httpMetadata?.contentType) headers["Content-Type"] = object.httpMetadata.contentType;
  if (object.httpMetadata?.cacheControl) headers["Cache-Control"] = object.httpMetadata.cacheControl;
  else headers["Cache-Control"] = "no-cache";
  return c.body(object.body, 200, headers);
});

app.get("/:slug", async (c, next) => {
  const slug = c.req.param("slug");
  // PRODUCTS is emitted by scripts/build-site.mjs as a JSON string (see the
  // `lit` helper), so parse it here rather than casting the module type.
  const products = JSON.parse(site.PRODUCTS ?? "{}") as Record<
    string,
    { html: string; etag: string; publishId: number }
  >;
  const entry = products[slug ?? ""];
  if (!entry) {
    // Not a prerendered product page. Let the static-file middleware (mounted
    // after the app routes in src/node.ts) serve any real file under siteDist
    // (hashed JS/CSS, robots.txt, sitemap.xml, ...) before giving up with 404.
    return await next();
  }
  // ETag revalidation: snapshot is immutable, so the ETag changes iff content
  // changed. A matching If-None-Match means the client already has the page.
  const inm = c.req.header("if-none-match");
  if (inm === entry.etag) {
    return c.body(null, 304);
  }
  return c.html(entry.html, 200, {
    ETag: entry.etag,
    "Cache-Control": "public, max-age=60, stale-while-revalidate=3600",
  });
});