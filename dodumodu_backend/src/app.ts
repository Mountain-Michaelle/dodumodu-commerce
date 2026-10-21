// The application itself — every route, with no runtime in it. This module is
// imported by BOTH entry points (src/index.ts for the Worker, src/node.ts for
// local Node), so there is exactly one copy of the routing, the middleware and
// the services in the repository, and switching environments switches the
// entry point and the config — never this file.
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { apiRateLimit, adminRateLimit, adminWriteRateLimit } from "./middleware/rateLimit";
import { catalogRoute } from "./routes/catalog";
import { ordersRoute } from "./routes/orders";
import { paymentsRoute } from "./routes/payments";
import { adminRoute } from "./routes/admin";
import { authRoute as adminAuthRoute, adminRoute as adminAuthAdminRoute } from "./auth/routes";
import { AUTH_BASE, ADMIN_BASE } from "./auth/config";
import { monthlyKpiSnapshotsRoute } from "./routes/monthlyKpiSnapshots";
import { visitorAnalyticsRoute } from "./routes/visitorAnalytics";
import { visitorRetentionRoute } from "./routes/visitorRetention";
import * as site from "./generated/site";

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
  app.use("/admin/*", adminRateLimit);
  app.use("/admin/*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      return next();
    }
    return adminWriteRateLimit(c, next);
  });
app.route("/admin", adminRoute);

// admin-auth v2 (feature-flagged). Mounted last and behind ADMIN_AUTH_V2: with
// the flag off every route 404s (flagGate), so this is a no-op deploy. /auth has
// no collision; the admin routes live under /admin-v2 so the existing /admin/*
// middleware and guard above are never wrapped or reordered (spec §2.4).
app.route(AUTH_BASE, adminAuthRoute);
app.route(ADMIN_BASE, adminAuthAdminRoute);

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
// /create-order, etc.) are mounted above and therefore never reach this handler.
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const products = (site as { PRODUCTS?: Record<string, { html: string; etag: string; publishId: number }> }).PRODUCTS ?? {};
  const entry = products[slug ?? ""];
  if (!entry) {
    return c.body(null, 404);
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