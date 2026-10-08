// Single source of truth for the DB shape. Mirrors §4 of the build spec exactly.
// Run `npm run db:generate` after any change here, then apply the migration.
import {
  pgTable, serial, text, integer, boolean, timestamp, jsonb, pgEnum, bigint, primaryKey, date, smallint,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const deliveryFeeTypeEnum = pgEnum("delivery_fee_type", ["free", "waybill"]);
export const deliveryDateChoiceEnum = pgEnum("delivery_date_choice", ["today", "tomorrow", "next_tomorrow"]);
export const paymentMethodEnum = pgEnum("payment_method", ["pay_now", "cod"]);
export const orderStatusEnum = pgEnum("order_status", [
  "awaiting_payment", "paid", "failed", "confirmed_cod", "delivered", "cancelled", "not_picking",
]);

// The catalogue's grouping, in the database instead of in everyone's memory.
// A product belongs to one category; a category may nest under another, so a
// flat catalogue and a nested one are the same table and a category listing
// later is a read rather than a redesign.
//
// The slug shape, the name length and "a category is not its own parent" are
// also CHECK constraints in migrations/0005_admin_domain.sql - the migration
// owns constraints and this file describes them, the same division payment_rules
// set up in 0002. Longer parent cycles are caught in categoryService, because a
// constraint cannot compare rows.
export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  parentId: integer("parent_id").references((): AnyPgColumn => categories.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  mediaR2Key: text("media_r2_key").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  price: integer("price").notNull(), // kobo, used when a package has no options
  packageOptions: jsonb("package_options").notNull().default([]), // [{ id, label, price }]
  // Nullable at the column level (see migrations/0005 for why) and required by
  // productService, which is where a missing category can be explained to the
  // person who needs to fix it.
  categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const productImages = pgTable("product_images", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  r2Key: text("r2_key").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  altText: text("alt_text").notNull(),
  width: integer("width"),   // source pixel size, for the aspect-ratio box
  height: integer("height"),
  variants: jsonb("variants").notNull().default([]), // renditions: [{ width, key }]
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const testimonials = pgTable("testimonials", {
  id: serial("id").primaryKey(),
  r2Key: text("r2_key").notNull(),
  title: text("title").notNull(),
  productId: integer("product_id").notNull().references(() => products.id),
  kind: text("kind").notNull().default("review"), // review card | whatsapp screenshot
  width: integer("width"),
  height: integer("height"),
  variants: jsonb("variants").notNull().default([]),
  description: text("description").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// The "global variable" for quantity discounts, made editable instead of
// hardcoded. Resolution: among ACTIVE tiers whose minQuantity <= the order's
// quantity, use the one with the highest minQuantity (see discountService.ts).
export const discountTiers = pgTable("discount_tiers", {
  id: serial("id").primaryKey(),
  minQuantity: integer("min_quantity").notNull().unique(),
  discountPercent: integer("discount_percent").notNull(),
  label: text("label"), // e.g. "Buy 3 or 4, save 20%" for the price-breakdown hint line
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// §5.13 — state-gated pay-on-delivery, made configurable instead of a hardcoded
// string in deliveryService.ts. Singleton: exactly one row, id = 1 (the CHECK
// constraint lives in migrations/0002_payment_rules.sql; drizzle's schema is
// descriptive here, the migration is the source of truth for constraints).
//
//   codStates         — states where COD may be chosen at all (matched with
//                       nigeriaStates.normalizeState, so "Abuja" and "FCT" agree)
//   codBulkThreshold  — the FIRST quantity that counts as a bulk order: 5 means
//                       1–4 may still use COD, 5+ must pay up front (a refused
//                       20-item COD delivery is a 20-item loss).
//
// Defaults in the migration, not repeated here: an order snapshot never changes
// (§8.7), so there is no FK from orders — the customer's chosen payment method
// is stored as they chose it, and this table only governs future checkouts.
export const paymentRules = pgTable("payment_rules", {
  id: serial("id").primaryKey(),
  codStates: text("cod_states").array().notNull(),
  codBulkThreshold: integer("cod_bulk_threshold").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});


export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  customerName: text("customer_name").notNull(),
  phone: text("phone").notNull(),
  // The canonical identity from the ONE shared normalizer (src/shared/normalizePhone.ts).
  // Written by the application on purpose: a GENERATED column would need a second,
  // SQL normalizer able to disagree with the TypeScript one. NULL means the number
  // could not be canonically resolved, and such rows are EXCLUDED from identity
  // checks, which fails open - never invented into an identity, never a refusal.
  phoneNorm: text("phone_norm"),
  // The address the order was placed from, nullable and best-effort. It exists so
  // abuse evidence can be shown ON this order. It is never an identity, never a
  // restriction key, and is masked everywhere it is displayed.
  createdFromIp: text("created_from_ip"),
  // A random value the client volunteers and reuses. NOT a browser fingerprint:
  // nothing here reads the canvas, fonts, GPU or any device-derived signal. A
  // self-declared id is forgeable and rotatable, and the rules are shaped around
  // that - a rotating-id bot is a documented gap, not an oversight.
  deviceId: text("device_id"),
  // Coarse in-app / browser / unknown. Never the raw User-Agent string: the report
  // only asks "in-app or not", and retaining a full UA on every order would be
  // personal data kept for no benefit.
  clientKind: text("client_kind"),
  whatsapp: text("whatsapp").notNull(),
  address: text("address").notNull(),
  state: text("state").notNull(),
  deliveryFeeType: deliveryFeeTypeEnum("delivery_fee_type").notNull(),
  deliveryDate: deliveryDateChoiceEnum("delivery_date").notNull(),
  flaggedLate: boolean("flagged_late").notNull().default(false),
  questionNotes: text("question_notes"),
  paymentMethod: paymentMethodEnum("payment_method").notNull(),

  // Quantity + pricing breakdown. Every field below is a snapshot taken at
  // order time — none of them are ever recomputed later, even if the
  // product price or discount tiers change (§8.7).
  packageId: text("package_id"),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: integer("unit_price").notNull(), // kobo, price of ONE unit at order time
  subtotal: integer("subtotal").notNull(), // unitPrice * quantity, before discount
  discountPercent: integer("discount_percent").notNull().default(0), // snapshot of the tier applied
  discountAmount: integer("discount_amount").notNull().default(0), // kobo saved
  amount: integer("amount").notNull(), // kobo, subtotal - discountAmount. This is what gets charged.
  currency: text("currency").notNull().default("NGN"),
  reference: text("reference").notNull().unique(),
  status: orderStatusEnum("status").notNull().default("awaiting_payment"),
  retryCount: integer("retry_count").notNull().default(0),
  lastCheckedAt: timestamp("last_checked_at"),
  // Set by the server when an order is marked delivered, cleared if that is ever
  // reverted. Not null-able-but-defaulted-to-a-date: "has never been delivered"
  // and "delivered at the epoch" are different facts and only one of them is true.
  deliveredAt: timestamp("delivered_at"),
  // When an order is cancelled, stores the status before cancellation so it can
  // be restored on reversal. NULL for non-cancelled orders and for permanent
  // cancellations (no reversal allowed).
  preCancellationStatus: text("pre_cancellation_status"),
  // Not Picking has its own previous state so cancellation and Not Picking
  // reversals each restore the state immediately before that action.
  preNotPickingStatus: text("pre_not_picking_status"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---- order-form abuse observation (migration 0008) ----
//
// Observation tables for the shadow phase. Deliberately NOT order statuses and
// NOT columns on orders: spam is a moderation concern, and keeping it in its own
// tables means pruning an observation can never touch a customer's order.
//
// No phone normalization lives in this schema. `phone_norm` holds the canonical
// E.164 identity produced by the single shared TypeScript normalizer; a SQL
// normalizer would be a second implementation able to disagree with it.

export const abuseIpWindows = pgTable("abuse_ip_windows", {
  ip: text("ip").notNull(),
  windowStart: bigint("window_start", { mode: "number" }).notNull(),
  posts: integer("posts").notNull().default(0),
  validationFailures: integer("validation_failures").notNull().default(0),
  turnstileFailures: integer("turnstile_failures").notNull().default(0),
  // The success interlock. One real order through an IP stops that IP being
  // treated as abusive however high its failure counts climb - which is what makes
  // a shared carrier NAT safe.
  successfulProgressions: integer("successful_progressions").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.ip, table.windowStart] }),
}));

export const abuseIpPhones = pgTable("abuse_ip_phones", {
  ip: text("ip").notNull(),
  windowStart: bigint("window_start", { mode: "number" }).notNull(),
  // The canonical identity. Never the last-8 shortcut: eight digits are not
  // globally unique and must never be able to implicate the wrong person.
  phoneNorm: text("phone_norm").notNull(),
  firstSeen: timestamp("first_seen").notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.ip, table.windowStart, table.phoneNorm] }),
}));

export const abuseObservations = pgTable("abuse_observations", {
  id: serial("id").primaryKey(),
  ip: text("ip"),
  // NULL when the submitted number could not be resolved. An unrecognized number
  // is recorded, never invented into an identity, and never used to refuse anyone.
  phoneNorm: text("phone_norm"),
  // The address the order was placed from, nullable and best-effort. It exists so
  // abuse evidence can be shown ON this order. It is never an identity, never a
  // restriction key, and is masked everywhere it is displayed.
  createdFromIp: text("created_from_ip"),
  outcome: text("outcome").notNull(),
  // What the rule WOULD have said, recorded even while shadow mode blocks nothing.
  wouldRestrict: boolean("would_restrict").notNull().default(false),
  reason: text("reason"),
  orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---- manual spam moderation (migration 0009) ----
//
// A moderation state that is deliberately NOT an order status. An order can be
// `awaiting_payment` while its phone carries an active flag, and flagging an
// order never touches orders.status, any payment state, or any fulfilment state.
// Folding "spam" into the status enum would force the OPay webhook, reconciliation
// and the delivery transitions to learn a concept none of them has.
//
// Nothing here is automatic: a flag only exists because an authorized admin gave a
// reason. Reverting fills in the revert columns rather than deleting, so "this was
// flagged and then somebody disagreed" stays visible.

export const spamFlags = pgTable("spam_flags", {
  id: serial("id").primaryKey(),
  // The canonical identity from the ONE shared normalizer. Never a last-8
  // shortcut: eight digits are not globally unique and would exclude an unrelated
  // customer who shared a suffix.
  phoneNorm: text("phone_norm").notNull(),
  // SET NULL if the order is deleted: the PHONE is what is blocked, and a phone
  // outlives any single order.
  sourceOrderId: integer("source_order_id").references(() => orders.id, { onDelete: "set null" }),
  // Mandatory, and meaningful - "spam" alone is rejected by the service.
  reason: text("reason").notNull(),
  // From the Access identity, never the request body, so it cannot be forged.
  flaggedBy: text("flagged_by").notNull(),
  flaggedAt: timestamp("flagged_at").notNull().defaultNow(),
  revertedAt: timestamp("reverted_at"),
  revertedBy: text("reverted_by"),
  revertReason: text("revert_reason"),
});

export const moderationBlocks = pgTable("moderation_blocks", {
  id: serial("id").primaryKey(),
  // 'ip' or 'device'. NEVER 'phone': an automatic burst block is a statement about
  // a machine, and a permanent decision about a person belongs to a human with a
  // reason. The CHECK constraint in the migration enforces this, so the shape is
  // refused by the database rather than merely avoided by convention.
  scope: text("scope").notNull(),
  value: text("value").notNull(),
  reason: text("reason").notNull(),
  // 'manual' | 'auto_v1' | 'auto_v2', kept distinct so an operator can see at a
  // glance whether a human or a rule made this call.
  source: text("source").notNull(),
  blockedBy: text("blocked_by").notNull(),
  blockedAt: timestamp("blocked_at").notNull().defaultNow(),
  // NULL means permanent, and only a MANUAL block may have NULL. Automatic blocks
  // always expire - the migration CHECK enforces that too.
  expiresAt: timestamp("expires_at"),
  releasedAt: timestamp("released_at"),
  releasedBy: text("released_by"),
  releaseReason: text("release_reason"),
  active: boolean("active").notNull().default(true),
  // The arithmetic that produced an automatic block: orders, window, phones,
  // devices, concentration. Readable later without re-running anything.
  evidence: jsonb("evidence"),
});

export const orderStatusHistory = pgTable("order_status_history", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id),
  oldStatus: text("old_status"),
  newStatus: text("new_status").notNull(),
  changedBy: text("changed_by").notNull(), // 'webhook' | 'reconcile' | 'admin:<email>' | 'system'
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});


// Product page content: one row per product. These are the sections that once
// lived hardcoded inside products/slug/index.html, so editing marketing copy
// never means editing the build. A save here is a DRAFT: it reaches customers
// only when a publish copies it into an immutable payload (publishService).
export const productPages = pgTable("product_pages", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().unique().references(() => products.id),
  summaryHtml: text("summary_html").notNull().default(""),
  benefits: jsonb("benefits").notNull().default([]), // [{ icon, title, body }]
  howToUse: jsonb("how_to_use").notNull().default([]), // [{ title, body }]
  faq: jsonb("faq").notNull().default([]), // [{ q, a }]
  whyLoveTitle: text("why_love_title").notNull().default("Why Nigerian Women Love This Serum"),
  howToUseTitle: text("how_to_use_title").notNull().default("How To Use For Best Results"),
  ratingValue: text("rating_value").notNull().default("4.9"),
  ratingCount: text("rating_count").notNull().default("1,048"),
  trustBadges: jsonb("trust_badges").notNull().default([]), // [{ icon, text }]
  deliveryBadge: text("delivery_badge").notNull().default(""),
  ctaText: text("cta_text").notNull().default("Place your order now"),
  heroAlt: text("hero_alt").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// The publish log. One row per publish: the complete page payload as it was at
// that moment, assembled from the live rows. Immutable - never updated, never
// removed by a later edit - so the static build always renders from a capture
// that cannot shift underneath it, and the newest row is what customers see.
export const productPublishes = pgTable("product_publishes", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  payload: jsonb("payload").notNull(),
  publishedBy: text("published_by").notNull(),
  buildStatus: text("build_status").notNull().default("triggered"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});


// An index of what object storage was ever handed, not a second copy of the
// catalogue. Whether a key is in use is answered by asking the tables that
// reference it (see mediaRepo), live - this table exists so that the set of keys
// anyone could ask about is enumerable in the first place.
//
// product_id is what the uploader said, not what is true: a useful filter for
// "uploaded and never attached", never a substitute for the reference query.
export const media = pgTable("media", {
  id: serial("id").primaryKey(),
  r2Key: text("r2_key").notNull().unique(),
  contentType: text("content_type").notNull().default(""),
  byteSize: integer("byte_size").notNull().default(0),
  width: integer("width"),
  height: integer("height"),
  productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
  uploadedBy: text("uploaded_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Phase 7a: Monthly KPI snapshots (immutable, written once per closed month).
// The current month is always computed live from orders; closed months use
// snapshot rows. Each snapshot captures the metrics as they were when the
// snapshot was taken. One row per month, keyed by month string (YYYY-MM).
export const monthlyKpiSnapshots = pgTable("monthly_kpi_snapshots", {
  id: serial("id").primaryKey(),
  month: text("month").notNull().unique(), // YYYY-MM format
  // Group A: real, non-spam order cohort and delivery metrics.
  totalValidOrders: integer("total_valid_orders").notNull().default(0),
  deliveredOrders: integer("delivered_orders").notNull().default(0), // non-spam delivered orders
  deliveredRevenue: integer("delivered_revenue").notNull().default(0), // kobo, order value, not collected cash
  // Group B: timing-based metrics
  deliveredInMonth: integer("delivered_in_month").notNull().default(0), // delivered during the month, regardless of creation month
  collectedAmount: integer("collected_amount"), // kobo; NULL until an authoritative collection source exists
  // Other metrics
  totalOrders: integer("total_orders").notNull().default(0),
  awaitingPaymentOrders: integer("awaiting_payment_orders").notNull().default(0),
  paidOrders: integer("paid_orders").notNull().default(0),
  failedOrders: integer("failed_orders").notNull().default(0),
  confirmedCodOrders: integer("confirmed_cod_orders").notNull().default(0),
  deliveredStatusOrders: integer("delivered_status_orders").notNull().default(0),
  cancelledOrders: integer("cancelled_orders").notNull().default(0),
  notPickingOrders: integer("not_picking_orders").notNull().default(0),
  spamFlaggedOrders: integer("spam_flagged_orders").notNull().default(0),
  abuseEvidenceOrders: integer("abuse_evidence_orders").notNull().default(0),
  payNowOrders: integer("pay_now_orders").notNull().default(0),
  codOrders: integer("cod_orders").notNull().default(0),
  // Snapshot metadata
  source: text("source").notNull(), // 'close' | 'lazy'
  definitionVersion: integer("definition_version").notNull().default(1),
  takenAt: timestamp("taken_at").notNull(),
  takenBy: text("taken_by"), // actor who triggered it, null for automatic close
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const visitorAnalyticsMeta = pgTable("visitor_analytics_meta", {
  id: smallint("id").primaryKey(),
  startedOn: date("started_on", { mode: "string" }).notNull(),
});

export const visitorDays = pgTable("visitor_days", {
  visitDate: date("visit_date", { mode: "string" }).notNull(),
  ipHash: text("ip_hash").notNull(),
  hashVersion: smallint("hash_version").notNull(),
  country: text("country"),
  region: text("region"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.visitDate, table.hashVersion, table.ipHash] }),
}));

export const visitorYearSnapshots = pgTable("visitor_year_snapshots", {
  year: integer("year").primaryKey(),
  uniqueVisitors: integer("unique_visitors").notNull(),
  complete: boolean("complete").notNull(),
  definitionVersion: integer("definition_version").notNull().default(1),
  takenAt: timestamp("taken_at").notNull(),
});
