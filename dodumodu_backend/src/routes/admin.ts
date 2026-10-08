import { Hono } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { ordersRepo } from "../data/ordersRepo";
import { productsRepo } from "../data/productsRepo";
import { testimonialsRepo } from "../data/testimonialsRepo";
import { productPagesRepo } from "../data/productPagesRepo";
import { publishesRepo } from "../data/publishesRepo";
import { publishService } from "../services/publishService";
import {
  verifyStorefront, resolvePublishState, publishVersion,
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
  resolvePrincipal, ACCESS_EMAIL_HEADER, PERMISSIONS, type Principal,
} from "../auth/adminAuth";
import { errorShape } from "../shared/httpError";
import { requirePermissionOf } from "./admin/helpers";
import { categoryRoutes } from "./admin/categories";
import { productRoutes } from "./admin/products";
import { orderRoutes } from "./admin/orders";
import { mediaRoutes } from "./admin/media";
import { spamRoutes } from "./admin/spam";
import { blockRoutes } from "./admin/blocks";
import { reportRoutes } from "./admin/reports";

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

export const adminRoute = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

adminRoute.use("*", async (c, next) => {
  try {
    // Read the identity Access vouched for, and turn it into a Principal - or
    // refuse. Never "assume it is behind Access so a hidden button is enough":
    // Access is a real boundary and this is where it is enforced.
    const principal = resolvePrincipal(c.req.header(ACCESS_EMAIL_HEADER), c.env.ADMIN_OPERATORS);
    c.set("principal", principal);
    await next();
  } catch (err) {
    return adminError(err);
  }
});

adminRoute.onError((err) => adminError(err));

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

  console.error(JSON.stringify({
    event: "admin_unhandled_error",
    name: code,
    message: err instanceof Error ? err.message : String(err),
  }));
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side. Nothing was changed." } },
    { status: 500 },
  );
}

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
  const db = createDb(c.env.DATABASE_URL);
  return c.json({ testimonials: await testimonialsRepo.listAll(db) });
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
    const { record, deployment } = await publishService.publish(db, c.env, product.slug, c.get("principal").email);
    // 200 either way, and deliberately so. The publish SUCCEEDED - the immutable
    // snapshot exists and is what customers will receive once the storefront
    // rebuilds. A deploy hook failure is reported in the body, because returning
    // 5xx here would tell the admin their publish failed when it did not, and
    // invite them to publish again over a perfectly good snapshot.
    return c.json({
      published: true,
      publishId: record.id,
      publishedAt: record.createdAt,
      payload: record.payload,
      deployment: {
        status: deployment.status,
        error: deployment.error,
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
  const verification = await verifyStorefront(c.env, product.slug);
  const liveVersion = verification.liveVersion;

  const state = resolvePublishState({
    latestPublishId: latest?.id ?? null,
    buildStatus: latest?.buildStatus ?? "pending",
    liveVersion,
  });

  return c.json({
    state,
    publishId: latest?.id ?? null,
    publishVersion: latest ? publishVersion(latest.id) : null,
    // What the storefront is actually serving. Deliberately reported even when it
    // matches, so the operator can see that a check happened rather than trust a
    // word that could equally have come from a stored flag.
    liveVersion,
    buildStatus: latest?.buildStatus ?? null,
    storefrontUrl: verification.url || null,
    // Why a check failed, when one did. "unconfigured" locally is normal, not an
    // error; the admin renders it as "not verified" rather than as a failure.
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

  const result = await publishService.redeploy(db, c.env, product.id);
  if (!result) {
    return c.json({ error: "This product has never been published" }, 404);
  }
  return c.json({
    published: true,
    publishId: result.publishId,
    deployment: {
      status: result.deployment.status,
      error: result.deployment.error,
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
