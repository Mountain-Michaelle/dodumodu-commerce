import { abuseRoutes } from "./admin/abuse";
import { isNonProduction } from "../config/environment";
import { isUsableSecret, secureEqual } from "../shared/secureEqual";
import { Context, Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createDb } from "../db";
import { ordersRepo } from "../data/ordersRepo";
import { productsRepo } from "../data/productsRepo";
import { testimonialsRepo } from "../data/testimonialsRepo";
import { productPagesRepo } from "../data/productPagesRepo";
import { publishesRepo } from "../data/publishesRepo";
import { deployProgress } from "../services/deployProgress";
import { served } from "../services/servedStorefront";
import { publishService } from "../services/publishService";
import { notificationService } from "../services/notificationService";
import {
  verifyStorefront, resolvePublishState,
} from "../services/storefrontStatus";
import { ProductNotFoundError } from "../services/catalogService";
import {
  statusUpdateSchema, testimonialUpsertSchema,
  discountTiersReplaceSchema, paymentRulesUpdateSchema,
  productPageUpsertSchema, publishRequestSchema,
} from "../validation/adminSchema";
import { discountTiersRepo } from "../data/discountTiersRepo";
import { paymentRulesRepo } from "../data/paymentRulesRepo";
import { codPolicyService } from "../services/codPolicyService";
import { orderCrmService } from "../services/orderCrmService";
import {
  resolvePrincipal, ACCESS_EMAIL_HEADER, PERMISSIONS, type Principal, ForbiddenError,
  UnauthorizedError,
} from "../auth/adminAuth";
import { errorShape } from "../shared/httpError";
import {
  adminBasePath,
  rewriteAdminHtml,
  rewriteAdminJs,
} from "../config/adminBase";
import { parseListQuery, pageMeta } from "../shared/listQuery";
import { requirePermissionOf } from "./admin/helpers";
import { mayCall, legacyFromGrants } from "../auth/route-access";
import { categoryRoutes } from "./admin/categories";
import { productRoutes } from "./admin/products";
import { orderRoutes } from "./admin/orders";
import { mediaRoutes } from "./admin/media";
import { spamRoutes } from "./admin/spam";
import { blockRoutes } from "./admin/blocks";
import { reportRoutes } from "./admin/reports";
import {
  ADMIN_LOGIN_HTML,
  ADMIN_AUTH_CSS,
  ADMIN_AUTH_JS,
  ADMIN_CONSOLE_HTML,
  ADMIN_SESSIONS_HTML,
  ADMIN_DEVICES_HTML,
  ADMIN_SESSIONS_JS,
  ADMIN_DEVICES_JS,
  ADMIN_UI_JS,
  ADMIN_DEVICE_ACCEPT_HTML,
  ADMIN_DEVICE_ACCEPT_JS,
  ADMIN_QR_JS,
  ADMIN_QR_LOGO_MJS,
  ADMIN_CONSOLE_ASSETS,
} from "../generated/adminPages";
import { logError } from "../shared/logger";
import { loadSession } from "../auth/middleware";
import { getSidToken } from "../auth/ctx";
import { adminAuthEnabled } from "../auth/config";

// The admin surface. Three kinds of route live here and the distinction is the
// point of the file:
//
//   - the resource routers below (categories, products, orders, media) are one
//     module per resource, and they are where a new resource goes;
//   - the settings and content routes below stay here, because discount tiers,
//     payment rules, product page copy and publishing are singletons rather than
//     listable resources, and splitting one endpoint per file would be structure
//     for its own sake;
//   - the authorization seam, which is applied ONCE, before any of them.
//
// Authorization is centralized here rather than repeated in every handler. The
// previous version had each route re-read the Access header, which is exactly the
// scattering a seam exists to prevent: adding a resource then meant remembering
// to add a check, and forgetting is silent.
//
// The error handler is here for the same reason. Every service throws one of the
// shared error types, and this is the single place those become a status and a
// body shape - so no route can invent its own error format, and no stack trace
// can reach a browser.

/** A write authenticated by a cookie must come from this very site (CSRF). Reads are always fine. */
function isSameOriginWrite(method: string, origin: string | undefined, host: string | undefined): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

export const adminRoute = new Hono<{ Bindings: Env; Variables: { principal: Principal; authType?: string } }>();

// Public paths exempt from the auth seam: the sign-in page and the assets it
// requires must load without a Cloudflare Access identity. Everything else under
// /admin remains protected.
const PUBLIC_PATHS = [
  "/sign-in",
  "/sign-in/",
  "/assets/auth.css",
  "/assets/auth.js",
  "/assets/sessions.js",
  "/assets/devices.js",
  "/assets/device-accept.js",
  "/assets/admin-ui.js",
  "/device/accept",
  "/device/accept/",
  "/assets/qr.js",
  "/assets/qr-logo.mjs",
];

function namespaceHtml(html: string, env: Env): string {
  const active = adminBasePath({
    ENVIRONMENT: env.ENVIRONMENT,
    ADMIN_BASE_PATH: env.ADMIN_BASE_PATH,
  });
  return active ? rewriteAdminHtml(html, active) : html;
}

function namespaceJs(js: string, env: Env): string {
  const active = adminBasePath({
    ENVIRONMENT: env.ENVIRONMENT,
    ADMIN_BASE_PATH: env.ADMIN_BASE_PATH,
  });
  return active ? rewriteAdminJs(js, active) : js;
}

// Auth middleware runs for every /admin/* path. Public paths are exempted
// inside the handler so the sign-in page and its assets load without an Access
// identity. All other routes require Cloudflare Access (or DEPLOY_TRIGGER_SECRET
// for CI build-status mutations).
adminRoute.use("*", async (c, next) => {
  // Public paths below bypass auth entirely: no identity is required, and none
  // is established. Loading the sign-in page is not authentication.
  //
  // c.req.path may be the full path (when mounted at /admin via app.route) or
  // the namespace-relative rest (when dispatched by src/app.ts). Match either
  // form.
  const isPublic = PUBLIC_PATHS.some(
    (p) => c.req.path === p || c.req.path.endsWith(p),
  );
  // The console bundle is the whole admin UI (every route it calls is in there), so it is no longer public:
  // it needs a signed-in session like the console page itself. Only the sign-in assets above stay open.
  const isConsoleAsset = c.req.method === "GET" && /\/assets\/admin\.[^.]+\.min\.(?:css|js)$/.test(c.req.path);
  if (isPublic) {
    return next();
  }
  try {
    // CI build-status mutations authenticate with DEPLOY_TRIGGER_SECRET instead of
    // Cloudflare Access. This keeps CI out of the Access identity model.
    const secret = c.env.DEPLOY_TRIGGER_SECRET;
    const auth = c.req.header("authorization");
    let principal: Principal;
    if (isUsableSecret(secret) && secureEqual(auth?.startsWith("Bearer ") ? auth.slice(7) : null, secret)) {
      c.set("authType", "build-secret");
      principal = { email: "ci@deploy", permissions: [] } as Principal;
    } else {
      // Who is asking. Two sources, and only one is believed per deployment:
      //  * Cloudflare Access: the identity header is trusted ONLY when admin-auth v2 is off (legacy
      //    deployments behind Access) or TRUST_ACCESS_HEADER=1 says Access really is in front. Without
      //    that, any visitor could send the header themselves and be an administrator.
      //  * An admin-auth v2 session (__Host-sid): the sign-in this deployment actually uses.
      const v2 = adminAuthEnabled(c.env as never);
      // Fail closed: in production the header counts only when TRUST_ACCESS_HEADER=1 says so on purpose. The
      // implicit "v2 is off, so trust it" rule applies to local/sandbox runs only (they have no Access in front).
      const accessTrusted = c.env.TRUST_ACCESS_HEADER === "1" || (!v2 && isNonProduction(c.env.ENVIRONMENT));
      const accessEmail = accessTrusted ? c.req.header(ACCESS_EMAIL_HEADER) : undefined;
      if (accessEmail || !v2) {
        principal = resolvePrincipal(accessEmail, c.env.ADMIN_OPERATORS);
        c.set("authType", "access");
      } else {
        if (!getSidToken(c as never)) throw new UnauthorizedError("no_session");   // anonymous: no database work
        const sess = await loadSession(c as never);
        if (!sess) throw new UnauthorizedError("no_session");
        // Non-admin operators are admitted, but only to the routes their grants allow (route-access.ts, default deny).
        // Every signed-in operator loads the console shell itself; what it then lets them open is the table's decision.
        const base = adminBasePath({ ENVIRONMENT: c.env.ENVIRONMENT, ADMIN_BASE_PATH: c.env.ADMIN_BASE_PATH }) ?? "/admin";
        const flat = c.req.path.replace(/\/+$/, "");
        const isShell = c.req.method === "GET" && (flat === "" || flat === base);   // the namespace may already be stripped from the path
        if (!isShell && !isConsoleAsset && !mayCall(sess.role, sess.perms, c.req.method, c.req.path)) throw new ForbiddenError(PERMISSIONS.ordersRead);
        if (!isSameOriginWrite(c.req.method, c.req.header("origin"), c.req.header("host"))) {
          throw new ForbiddenError(PERMISSIONS.ordersWrite);                          // cookie-authenticated writes must come from this site
        }
        principal = sess.role === "admin"
          ? { ...resolvePrincipal(sess.email, c.env.ADMIN_OPERATORS), role: "admin" }
          : { email: sess.email.trim().toLowerCase(), permissions: legacyFromGrants(sess.role, sess.perms), role: sess.role };
        c.set("authType", "session");
      }
    }
    c.set("principal", principal);

    // Hono mounted-router quirk: get("/") does not match path "/" inside a
    // router mounted at "/admin", so /admin/ (trailing slash) falls through to
    // 404 even though adminRoute.get("/", ...) is registered. Serve the console
    // page directly for that path after successful auth resolution.
    if (c.req.path === "/" || c.req.path === "/admin" || c.req.path === "/admin/") {
      return c.html(namespaceHtml(ADMIN_CONSOLE_HTML, c.env), 200);
    }

    await next();
  } catch (err) {
    return adminError(err);
  }
});

// Public routes — serve only static HTML/CSS/JS, expose no privileged data.
// These are registered AFTER the middleware so the middleware runs first, but
// the PUBLIC_PATHS check above lets them through without auth.
// Explicit Content-Type headers ensure test assertions pass consistently.
// An administrator who already has a valid session must not be shown the sign-in page again: send them to
// the console. Same rule the console root uses to send an unauthenticated visitor here (admin session only),
// so the two redirects can never chase each other. Any failure just shows the sign-in page.
async function signInPage(c: Context<{ Bindings: Env }>) {
  const active = adminBasePath({
    ENVIRONMENT: c.env.ENVIRONMENT,
    ADMIN_BASE_PATH: c.env.ADMIN_BASE_PATH,
  });
  if (adminAuthEnabled(c.env as never) && getSidToken(c as never)) {
    try {
      const session = await loadSession(c as never);
      if (session && session.role === "admin") return c.redirect(`${active ?? "/admin"}/`, 302);
    } catch (e) {
      logError("sign_in_session_check_failed", e);
    }
  }
  c.header("Cache-Control", "no-store");
  return c.html(active ? rewriteAdminHtml(ADMIN_LOGIN_HTML, active) : ADMIN_LOGIN_HTML, 200);
}
adminRoute.get("/sign-in", (c) => signInPage(c as never));
adminRoute.get("/sign-in/", (c) => signInPage(c as never));

// Static sign-in/console-page assets. Their URLs carry no content hash (the page references plain names), so they cannot be
// "immutable"; instead they get a content ETag and a short freshness window: a repeat visit costs nothing or a 304 with no
// body, and a deploy reaches every browser within minutes. (The hashed console bundle below stays immutable.)
const etagMemo = new Map<string, string>();
function weakEtag(body: string): string {
  let tag = etagMemo.get(body);
  if (!tag) {
    let h = 0x811c9dc5;   // FNV-1a: cheap and non-secret; it only has to change when the content changes
    for (let i = 0; i < body.length; i++) { h ^= body.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    tag = `W/"${h.toString(36)}-${body.length.toString(36)}"`;
    if (etagMemo.size > 64) etagMemo.clear();
    etagMemo.set(body, tag);
  }
  return tag;
}
function staticAsset(c: { req: { header: (k: string) => string | undefined }; header: (k: string, v: string) => void; body: (b: string | null, s: 200 | 304) => Response }, body: string, type: string): Response {
  const etag = weakEtag(body);
  c.header("Content-Type", type);
  c.header("ETag", etag);
  c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  return c.body(body, 200);
}
const JS = "text/javascript; charset=utf-8", CSS = "text/css; charset=utf-8";
adminRoute.get("/assets/auth.css", (c) => staticAsset(c as never, ADMIN_AUTH_CSS, CSS));
adminRoute.get("/assets/auth.js", (c) => staticAsset(c as never, namespaceJs(ADMIN_AUTH_JS, c.env), JS));
adminRoute.get("/assets/sessions.js", (c) => staticAsset(c as never, namespaceJs(ADMIN_SESSIONS_JS, c.env), JS));
adminRoute.get("/assets/devices.js", (c) => staticAsset(c as never, namespaceJs(ADMIN_DEVICES_JS, c.env), JS));
adminRoute.get("/assets/admin-ui.js", (c) => staticAsset(c as never, namespaceJs(ADMIN_UI_JS, c.env), JS));
adminRoute.get("/assets/device-accept.js", (c) => {
  c.header("Content-Type", "text/javascript; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(namespaceJs(ADMIN_DEVICE_ACCEPT_JS, c.env), 200);
});
// Invite page: static, public, redeems nothing on GET (the button POSTs; the token rides in the #fragment).
const deviceAcceptPage = (c: { env: Env; html: (h: string, s: 200) => Response; header: (k: string, v: string) => void }) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(namespaceHtml(ADMIN_DEVICE_ACCEPT_HTML, c.env), 200);
};
adminRoute.get("/device/accept", (c) => deviceAcceptPage(c as never));
adminRoute.get("/device/accept/", (c) => deviceAcceptPage(c as never));
adminRoute.get("/assets/qr.js", (c) => staticAsset(c as never, ADMIN_QR_JS, JS));
adminRoute.get("/assets/qr-logo.mjs", (c) => staticAsset(c as never, ADMIN_QR_LOGO_MJS, JS));
adminRoute.get("/assets/:asset", (c) => {
  const filename = c.req.param("asset");
  const asset = ADMIN_CONSOLE_ASSETS[filename as keyof typeof ADMIN_CONSOLE_ASSETS];
  if (!asset) return c.text("Not found", 404);
  c.header("Content-Type", filename.endsWith(".css")
    ? "text/css; charset=utf-8"
    : "text/javascript; charset=utf-8");
  c.header("Cache-Control", "private, max-age=31536000, immutable");
  return c.body(asset, 200);
});

// Guarded console pages — require an Access identity (set by the middleware
// above). Mounted here on adminRoute so they are reachable under /admin in
// production, where this router owns every /admin/* path.
// Console routes are handled at the app level in index.ts
// Console routes are handled at the app level in index.ts
// Console routes are handled at the app level in index.ts
// Console routes are handled at the app level in index.ts
// Console routes are handled at the app level in index.ts
// Console routes are handled at the app level in index.ts

adminRoute.get("", (c) => c.html(namespaceHtml(ADMIN_CONSOLE_HTML, c.env), 200));
adminRoute.get("/", (c) => c.html(namespaceHtml(ADMIN_CONSOLE_HTML, c.env), 200));
adminRoute.get("/sessions", (c) => c.html(namespaceHtml(ADMIN_SESSIONS_HTML, c.env), 200));
adminRoute.get("/sessions/", (c) => c.html(namespaceHtml(ADMIN_SESSIONS_HTML, c.env), 200));
adminRoute.get("/devices", (c) => c.html(namespaceHtml(ADMIN_DEVICES_HTML, c.env), 200));
adminRoute.get("/devices/", (c) => c.html(namespaceHtml(ADMIN_DEVICES_HTML, c.env), 200));
// The standalone users page is retired: Users & access is the console's #users section. Old links and
// bookmarks land there (an anonymous visitor is sent to sign-in first by the dispatcher in app.ts).
const toConsoleUsers = (c: { env: Env; redirect: (to: string, status: 302) => Response }) => {
  const active = adminBasePath({ ENVIRONMENT: c.env.ENVIRONMENT, ADMIN_BASE_PATH: c.env.ADMIN_BASE_PATH });
  return c.redirect(`${active ?? "/admin"}/#users`, 302);
};
adminRoute.get("/users", (c) => toConsoleUsers(c));
adminRoute.get("/users/", (c) => toConsoleUsers(c));

/**
 * The one place a thrown error becomes an HTTP response.
 *
 * Returns null-safe output for our own errors and lets anything else become a 500
 * with a message that says nothing about the internals. A stack trace in a JSON
 * body tells an attacker the file layout, the ORM and often the query, so an
 * unexpected fault is logged and answered plainly.
 */
function adminError(err: unknown) {
  const shape = errorShape(err);
  if (shape) return Response.json(shape.body, { status: shape.status });

  const code = err instanceof Error ? err.name : "UnknownError";
  if (code === "UnauthorizedError") {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "Sign in to use the admin" } }, { status: 401 });
  }
  if (code === "ForbiddenError") {
    return Response.json({ error: { code: "FORBIDDEN", message: "You do not have permission to do that" } }, { status: 403 });
  }

  logError("admin_unhandled_error", err);
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side. Nothing was changed." } },
    { status: 500 },
  );
}

adminRoute.onError((err) => adminError(err));

// ---------------------------------------------------------------------------
// Resource routers. Mounted before the singleton routes below so that a path
// like /orders/bulk-action is matched by the resource router rather than being
// swallowed as an /orders/:id.
// ---------------------------------------------------------------------------
adminRoute.route("/categories", categoryRoutes());
adminRoute.route("/products", productRoutes());
adminRoute.route("/orders", orderRoutes());
adminRoute.route("/media", mediaRoutes());
// Spam moderation is mounted here, behind the same Access gate and the same
// permission checks as every other admin surface. It is a separate router because
// it is a separate concern: nothing in it changes an order's status, payment state
// or fulfilment state, and no public route can reach it.
adminRoute.route("/spam", spamRoutes);
adminRoute.route("/blocks", blockRoutes);
// Held (spam) orders and rotating-phone-flood suspects: administrators only, blocking behind a step-up.
adminRoute.route("/abuse", abuseRoutes);
adminRoute.route("/reports", reportRoutes);

/** The operator, for the panel's own header. */
adminRoute.get("/me", (c) => {
  const principal = c.get("principal");
  return c.json({
    email: principal.email,
    permissions: principal.permissions,
  });
});

// ---------------------------------------------------------------------------
// Compatibility endpoints.
//
// The orders/products/media routes above are the real ones. The two below are
// kept because a panel that predates this change still calls them, and the
// specification is explicit that existing functionality must keep working.
// They are thin adapters onto the same services, so there is no second copy of
// any rule - an old client and a new one cannot disagree about what is allowed.
//
// /orders/:id/status is the interesting one. It is kept because it existed, but
// it is NOT the payment authority: it refuses to move an order into a paid state,
// because that is what paymentService and the webhook own. An operator marking a
// delivery uses /orders/:id/deliver, which keeps the two lifecycles apart.
// ---------------------------------------------------------------------------
adminRoute.patch("/orders/:id/status", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersPaymentOverride);
  const body = await c.req.json().catch(() => null);
  const parsed = statusUpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid request" } }, 400);

  const db = createDb(c.env.DATABASE_URL);
  const orderId = Number(c.req.param("id"));
  const order = await ordersRepo.findById(db, orderId);
  if (!order) return c.json({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);

  // Payment states are refused here and pointed at the dedicated endpoint. This
  // route existed before the CRM split, and leaving it able to settle a payment
  // would hand the panel a second, unguarded way to do the thing the webhook is
  // the authority for.
  if (parsed.data.toStatus === "paid" || parsed.data.toStatus === "failed") {
    return c.json({
      error: {
        code: "USE_DEDICATED_ENDPOINT",
        message: `Use POST /admin/orders/${orderId}/mark-paid or /mark-failed for payment overrides.`,
      },
    }, 409);
  }

  // A delivery target goes through orderCrmService, NOT applyStatusTransition. That
  // service sets status and delivered_at in ONE statement, so an operator using
  // this old endpoint cannot leave "delivered, never delivered at" - the state
  // the specification forbids and the one that makes a delivery undatable. Before
  // this, the two columns were written separately and the gap was real.
  if (parsed.data.toStatus === "delivered") {
    const order = await orderCrmService.deliver(
      db, orderId, null, `admin:${c.get("principal").email}`, parsed.data.reason,
    );
    return c.json({ order });
  }

  const result = await ordersRepo.applyStatusTransition(
    db, orderId, order.status, parsed.data.toStatus, `admin:${c.get("principal").email}`, parsed.data.reason,
  );
  if (result.illegal) {
    return c.json({
      error: { code: "ILLEGAL_TRANSITION", message: `Illegal transition: ${order.status} -> ${parsed.data.toStatus}` },
    }, 400);
  }
  if (!result.applied) {
    return c.json({
      error: { code: "RECORD_CONFLICT", message: "Order status changed concurrently, refresh and retry" },
      action: "reload",
    }, 409);
  }

  console.log(JSON.stringify({
    event: "admin_status_changed", reference: order.reference, toStatus: parsed.data.toStatus,
  }));
  return c.json({ order: result.order });
});

adminRoute.get("/testimonials", async (c) => {
  requirePermissionOf(c, PERMISSIONS.productsRead);
  // Server-side pages: a testimonial list grows without limit, and an endpoint
  // that returns every row turns one long page into one long query. page/pageSize
  // go through the shared parser, so the same 1..1000 ceiling applies here as on
  // every other admin list.
  const query = parseListQuery(c.req.query(), {
    filters: z.object({}),
    sortable: ["displayOrder"],
    defaultSort: "displayOrder",
    defaultOrder: "asc",
  });
  if (!query) {
    return c.json({ error: { code: "INVALID_QUERY", message: "That paging request is not valid" } }, 400);
  }
  const db = createDb(c.env.DATABASE_URL);
  const { rows, total } = await testimonialsRepo.listPaged(db, query.limit, query.offset);
  return c.json({ testimonials: rows, page: pageMeta(query, total) });
});

adminRoute.put("/testimonials/:id?", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = testimonialUpsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid testimonial", fields: parsed.error.flatten().fieldErrors }, 400);

  const idParam = c.req.param("id");
  const db = createDb(c.env.DATABASE_URL);
  // Testimonials belong to a product now. A panel that predates that change
  // still posts without one, and while the catalogue has exactly one product
  // there is only one honest answer — the same one migration 0004 backfilled.
  // With more than one product the request has to say which: attaching a review
  // to whichever product happens to sort first would be a silent wrong answer.
  let productId = parsed.data.productId;
  if (!productId) {
    const all = await productsRepo.listAll(db);
    if (all.length !== 1) {
      return c.json({ error: "productId is required while more than one product exists" }, 400);
    }
    productId = all[0].id;
  }
  const testimonial = await testimonialsRepo.upsert(db, {
    ...parsed.data,
    productId,
    id: idParam ? Number(idParam) : undefined,
  });
  return c.json({ testimonial });
});

// §5.12 — a small, flat, admin-editable table: the "global variable" for
// quantity discounts. GET returns everything (active and inactive) so the
// admin panel can show what's currently off; PUT replaces the whole set.
adminRoute.get("/discount-tiers", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  return c.json({ discountTiers: await discountTiersRepo.listAll(db) });
});

adminRoute.put("/discount-tiers", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = discountTiersReplaceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid discount tiers", issues: parsed.error.issues.map((i) => i.message) }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);
  const tiers = await discountTiersRepo.replaceAll(db, parsed.data.map((t) => ({
    minQuantity: t.minQuantity,
    discountPercent: t.discountPercent,
    label: t.label ?? null,
    active: t.active,
  })));

  console.log(JSON.stringify({ event: "admin_discount_tiers_updated", by: c.get("principal").email, tierCount: tiers.length }));
  return c.json({ discountTiers: tiers });
});

// §5.13 — pay-on-delivery eligibility: which states may choose it, and the
// largest quantity still eligible. Singleton row, so PUT is an update, not a
// replace. GET returns exactly what page-data publishes, so the admin can see
// the rules as the customer's form sees them.
adminRoute.get("/payment-rules", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const rules = await paymentRulesRepo.get(db);
  return c.json({ paymentRules: codPolicyService.publicRules(rules) });
});

adminRoute.put("/payment-rules", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = paymentRulesUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: "Invalid payment rules",
      fields: parsed.error.flatten().fieldErrors,
    }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);
  const saved = await paymentRulesRepo.update(db, parsed.data);

  console.log(JSON.stringify({
    event: "admin_payment_rules_updated", by: c.get("principal").email,
    codStateCount: saved.codStates.length, codBulkThreshold: saved.codBulkThreshold,
  }));
  return c.json({ paymentRules: codPolicyService.publicRules(saved) });
});


// ---------------------------------------------------------------------------
// Product page content, and the publish that makes it visible.
//
// Saving and publishing are two endpoints because they have two different
// blast radii: a save can only ever be wrong in the admin panel, while a publish
// is wrong on the storefront. Keeping them apart is what lets the form save on
// every keystroke-loss fear removed, without a customer ever seeing the result.
// ---------------------------------------------------------------------------
adminRoute.get("/products/:id/page", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const product = await productsRepo.findById(db, Number(c.req.param("id")));
  if (!product) return c.json({ error: "Product not found" }, 404);
  // null here is not an empty page: it means nobody has edited this product's
  // copy yet, so the column defaults are what a publish would capture.
  return c.json({ page: await productPagesRepo.forProduct(db, product.id) });
});

adminRoute.put("/products/:id/page", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const product = await productsRepo.findById(db, Number(c.req.param("id")));
  if (!product) return c.json({ error: "Product not found" }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = productPageUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: "Invalid page content",
      fields: parsed.error.flatten().fieldErrors,
    }, 400);
  }

  const page = await productPagesRepo.save(db, product.id, parsed.data);
  console.log(JSON.stringify({
    event: "admin_page_saved", slug: product.slug, by: c.get("principal").email,
  }));
  return c.json({ page });
});

// The publish itself. It takes no body: the snapshot is assembled from the rows,
// and a body would be a second, divergent way of saying what the page contains —
// rejected rather than ignored, because silently dropping what an admin thought
// they sent is worse than an error message.
adminRoute.post("/products/:id/publish", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const product = await productsRepo.findById(db, Number(c.req.param("id")));
  if (!product) return c.json({ error: "Product not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  if (!publishRequestSchema.safeParse(body).success) {
    return c.json({ error: "A publish takes no body" }, 400);
  }

  try {
    const { record, deployment, reused, outcome, buildId } =
      await publishService.publish(db, c.env, product.slug, c.get("principal").email);
    if (outcome === "dispatched") {
      try {
        await notificationService.createForAdmins(db, {
          type: "publish_requested",
          title: "Product publish requested",
          body: `${product.name} - rebuild ${deployment.status}`,
          href: `/products/${product.id}`,
          dedupeKey: `publish-requested:${buildId}`,
        });
      } catch (err) {
        console.error(JSON.stringify({
          event: "notification_create_failed", notificationType: "publish_requested",
          publishId: record.id, error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
    // 200 either way, and deliberately so. The publish SUCCEEDED - the immutable snapshot exists and is
    // what customers receive once the storefront rebuilds. A dispatch failure is reported in the body,
    // with GitHub's own reason, because a 5xx would tell the admin their publish failed when it did not.
    return c.json({
      published: true,
      // true when the content was identical to the newest publish: nothing new was created.
      reused,
      // dispatched | already-running | unchanged
      outcome,
      publishId: record.id,
      publishRef: record.publishRef,
      buildId,
      publishedAt: record.createdAt,
      deployment: {
        status: deployment.status,
        error: deployment.error,
        httpStatus: deployment.httpStatus,
        retryable: deployment.retryable,
      },
    });
  } catch (err) {
    if (err instanceof ProductNotFoundError) {
      return c.json({ error: "Product not found" }, 404);
    }
    throw err;
  }
});

/**
 * The deployment status of a product, as OBSERVED rather than as claimed.
 *
 * This is a GET and it performs a real network fetch of the public product page.
 * That is deliberate and is the only way to answer the question the operator is
 * actually asking. A stored "deployed" flag would answer "what did we ask for
 * last time", which is a different question and the one that produces a panel
 * confidently showing LIVE for a page that has since been replaced.
 *
 * The fetch is to the PUBLIC storefront origin, not this API: what matters is the
 * bytes a customer receives.
 */
adminRoute.get("/products/:id/status", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const product = await productsRepo.findById(db, Number(c.req.param("id")));
  if (!product) return c.json({ error: "Product not found" }, 404);

  const latest = await publishesRepo.latestForProduct(db, product.id);
  const verification = await verifyStorefront(c.env, product.slug, served.read);
  const liveVersion = verification.liveVersion;
  // The build behind the newest publish: its steps, its failure, its run link. Read fresh on every call
  // so the panel can poll it; nothing here is a stored claim that the page is live.
  const progress = latest ? await deployProgress(db, latest) : null;

  // One effective status from the evidence: a failed or stalled build wins over a stale "pending" flag,
  // and LIVE is decided only by the storefront marker below.
  const effective =
    progress?.state === "failed" ? "failed"
      : progress?.state === "running" || progress?.state === "verified" ? "triggered"
        : latest?.buildStatus ?? "pending";

  const state = resolvePublishState({
    latestPublishRef: latest?.publishRef ?? null,
    buildStatus: effective,
    liveVersion,
  });

  return c.json({
    state,
    publishId: latest?.id ?? null,
    publishRef: latest?.publishRef ?? null,
    // Kept for the panel's existing field: it is the same public ref.
    publishVersion: latest?.publishRef ?? null,
    // What the storefront is actually serving, reported even when it matches so the operator can see a
    // check happened rather than trust a word that could equally have come from a stored flag.
    liveVersion,
    buildStatus: latest?.buildStatus ?? null,
    build: progress,
    // Why the last dispatch or build failed, in one place for the panel.
    deployError: progress?.error ?? latest?.deployError ?? null,
    deployHttpStatus: latest?.deployHttpStatus ?? null,
    deployAttempts: latest?.deployAttempts ?? 0,
    deployAttemptedAt: latest?.deployAttemptedAt ?? null,
    storefrontUrl: verification.url || null,
    // "unconfigured" locally is normal, not an error; the admin renders it as "not verified".
    verificationReason: verification.reason,
    checkedAt: new Date().toISOString(),
  });
});

// Retry the storefront rebuild for an existing snapshot. It publishes nothing and
// assembles nothing: the content is already captured, so this is free and cannot
// change what shoppers receive. 404 when the product has never been published,
// which is a different problem from a failed deploy and needs its own message.
adminRoute.post("/products/:id/redeploy", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const product = await productsRepo.findById(db, Number(c.req.param("id")));
  if (!product) return c.json({ error: "Product not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  if (!publishRequestSchema.safeParse(body).success) {
    return c.json({ error: "A redeploy takes no body" }, 400);
  }

  const result = await publishService.redeploy(db, c.env, product.id, c.get("principal").email);
  if (!result) {
    return c.json({ error: "This product has never been published" }, 404);
  }
  return c.json({
    published: true,
    outcome: result.outcome,
    publishId: result.publishId,
    publishRef: result.publishRef,
    buildId: result.buildId,
    deployment: {
      status: result.deployment.status,
      error: result.deployment.error,
      httpStatus: result.deployment.httpStatus,
      retryable: result.deployment.retryable,
    },
  });
});

// The publish log, newest first and without payloads. This is the answer to "did
// that change actually go out, and when" — the question a draft view cannot
// answer, which is the whole reason the log exists.
adminRoute.get("/products/:id/publishes", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const product = await productsRepo.findById(db, Number(c.req.param("id")));
  if (!product) return c.json({ error: "Product not found" }, 404);
  return c.json({ publishes: await publishesRepo.listForProduct(db, product.id) });
});
