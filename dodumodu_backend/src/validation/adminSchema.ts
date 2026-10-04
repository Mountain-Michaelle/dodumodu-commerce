import { z } from "zod";
// displayState ("enugu" -> "Enugu") now lives in services/nigeriaStates alongside
// normalizeState, so there is one definition of what a state looks like rather
// than one here and one there. Matching still never depends on the display form:
// normalizeState is applied to both sides first.
import { normalizeState, displayState } from "../services/nigeriaStates";

export const statusUpdateSchema = z.object({
  toStatus: z.enum(["awaiting_payment", "paid", "failed", "confirmed_cod", "delivered"]),
  reason: z.string().trim().max(300).optional(),
});

export const productUpsertSchema = z.object({
  slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1),
  price: z.number().int().positive(), // kobo, used when a package has no options
  packageOptions: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    price: z.number().int().positive().optional(),
  })).default([]),
  seoTitle: z.string().trim().max(200).optional(),
  seoDescription: z.string().trim().max(300).optional(),
  active: z.boolean().default(true),
});

// Two kinds of proof, one table: a written review card and a WhatsApp
// screenshot. They share ordering and visibility and differ in one thing the
// renderer cares about — whether there is an image at all — so r2_key may be
// empty for a review, while a screenshot without one would render a broken
// frame. That rule spans two fields, which is why it is a refine rather than a
// field rule.
export const testimonialUpsertSchema = z.object({
  productId: z.number().int().positive().optional(),
  kind: z.enum(["review", "whatsapp"]).default("review"),
  r2Key: z.string().trim().max(300).default(""),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1),
  displayOrder: z.number().int().default(0),
  width: z.number().int().min(0).max(20000).optional().nullable(),
  height: z.number().int().min(0).max(20000).optional().nullable(),
  variants: z.array(z.object({
    width: z.number().int().positive(),
    key: z.string().min(1).max(300),
  })).max(8).default([]),
  active: z.boolean().default(true),
}).refine((t) => t.kind !== "whatsapp" || t.r2Key.length > 0, {
  message: "A WhatsApp screenshot needs an uploaded image",
  path: ["r2Key"],
});

// Order list FILTERS only. The page size, the page number, the search term and
// the sort all belong to the shared parser in shared/listQuery.ts, because those
// four are identical for every admin table and re-deciding them per resource is
// how one of them eventually stops being bounded.
//
// The filters own their own keys and ignore everything else in the query string,
// so adding one is a schema edit and nothing else. Absence means "no filter",
// never a default that silently hides rows.
//
// from/to are ISO dates, not timestamps: an operator picking "the 3rd" means a
// whole day. `to` is pushed to the END of its own day, because a naive
// `created_at <= 2026-01-03` excludes almost all of the 3rd and is the kind of
// bug that makes a date filter look broken and get abandoned.
const orderStatusFilter = z.enum([
  "awaiting_payment", "paid", "failed", "confirmed_cod", "delivered",
]);

export const orderListFiltersSchema = z.object({
  status: orderStatusFilter.optional(),
  paymentMethod: z.enum(["pay_now", "cod"]).optional(),
  productId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
});

export type OrderListFiltersInput = z.infer<typeof orderListFiltersSchema>;

// Kept because the panel and the existing tests reference it, and because a
// status-only listing is genuinely the common case. It is now just the filters
// plus the shared page size ceiling rather than a second, parallel parser.
export const orderListQuerySchema = orderListFiltersSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(50),
});

// §5.12 — the whole tier set is replaced together and validated together:
// at least one tier anchored at min_quantity 1 (so an un-tiered quantity
// always resolves to a defined percent, even if it's 0%), no duplicate
// min_quantity values, every percent in 0..100. A bad set is rejected whole,
// never partially applied.
const discountTierSchema = z.object({
  minQuantity: z.number().int().min(1),
  discountPercent: z.number().int().min(0).max(100),
  label: z.string().trim().max(120).optional().nullable(),
  active: z.boolean().default(true),
});

export const discountTiersReplaceSchema = z.array(discountTierSchema)
  .min(1, "At least one discount tier is required")
  .superRefine((tiers, ctx) => {
    const quantities = tiers.map((t) => t.minQuantity);
    if (!quantities.includes(1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A tier with min_quantity = 1 is required so every quantity resolves to a defined percent",
      });
    }
    const duplicates = quantities.filter((q, i) => quantities.indexOf(q) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate min_quantity values: ${[...new Set(duplicates)].join(", ")}`,
      });
    }
  });

// §5.13 — the COD rules (eligible states + the bulk-quantity ceiling).
//
// The state list is normalised on the way IN, not just compared that way at
// read time: the admin types "abuja, lagos,  Lagos ", and the page advertises
// exactly what is stored. Doing it here means the two never disagree, and
// duplicate spellings of one state collapse to the first spelling entered.
//
// An empty list is VALID and means "no COD anywhere" — that's the whole point of
// making it editable; only a malformed payload is rejected.
const stateInput = z.string().trim().min(2).max(60);

export const paymentRulesUpdateSchema = z.object({
  codStates: z.array(stateInput).max(60, "Too many states in the list")
    .transform((states) => {
      const seen = new Map<string, string>();
      for (const state of states) {
        const key = normalizeState(state);
        if (!key) continue;
        if (!seen.has(key)) seen.set(key, displayState(state));
      }
      return [...seen.values()];
    }),
  // 0 is allowed: it turns COD off everywhere without touching the state list,
  // which is the quickest thing to do when a logistics partner lets you down.
  codBulkThreshold: z.number().int("Enter a whole number of items").min(0).max(1000),
});

export type PaymentRulesUpdate = z.infer<typeof paymentRulesUpdateSchema>;


// ---------------------------------------------------------------------------
// Product page content (the CMS fields an admin edits before publishing).
//
// These shapes are the contract between the admin form and the page the
// customer reads: a field that is not here cannot reach the page, and a field
// that is here without a bound is a way for one save to grow past what the
// renderer can hold. So every list is capped and every string is capped.
// ---------------------------------------------------------------------------

const benefitSchema = z.object({
  icon: z.string().trim().max(40).optional().nullable(), // emoji, or an icon name the build knows
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(600),
});

const stepSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(600),
});

const faqSchema = z.object({
  q: z.string().trim().min(1).max(200),
  a: z.string().trim().min(1).max(1200),
});

const badgeSchema = z.object({
  icon: z.string().trim().max(40).optional().nullable(),
  text: z.string().trim().min(1).max(80),
});

// The summary is rich text on purpose: it carries inline emphasis today, and
// forcing an admin to give up emphasis to satisfy a schema is how they end up
// typing "very" twice. What it must not carry is markup that executes or reaches
// the network, so every tag is dropped except this short list — and a surviving
// tag is rebuilt from its own name, never from the submitted bytes, so an
// attribute (<a href=...>, onmouseover=..., style=...) cannot ride through in the
// text of a tag we decided to keep.
const ALLOWED_SUMMARY_TAGS = ["strong", "em", "b", "i", "br"];

export function sanitizeSummaryHtml(value: string): string {
  const withoutBlockedBlocks = value.replace(
    /<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    "",
  );
  // Splitting keeps every complete tag as a piece of its own. A piece that is
  // not a tag is text, and text gives up any "<" it still holds - which is what
  // neutralises a fragment like "<strong" without taking the sentence around it
  // down with it. Blanketing the whole field for one stray bracket reads as a
  // save that silently deletes an admin's copy, so it is the fragment that goes.
  const clean = withoutBlockedBlocks
    .split(/(<[^>]+>)/g)
    .map((piece) => {
      if (!piece.startsWith("<")) return piece.replace(/</g, "");
      const name = /<\/?\s*([a-z][a-z0-9]*)/i.exec(piece)?.[1]?.toLowerCase();
      if (!name || !ALLOWED_SUMMARY_TAGS.includes(name)) return "";
      return piece.startsWith("</") ? `</${name}>` : `<${name}>`;
    })
    .join("");
  return clean.trim().slice(0, 4000);
}

// Every field is optional on the way in, because the form saves the section an
// admin is working on rather than a re-serialisation of the whole page: absent
// means "leave that column exactly as it is", and the insert path falls back to
// the column defaults. What is present must still be well-formed — a partial
// save is not a licence to save junk.
//
// The array fields replace wholesale. There is no id to reconcile against and a
// page always shows the whole list, so a merge would have to invent an identity
// for items that never had one.
export const productPageUpsertSchema = z.object({
  summaryHtml: z.string().max(4000).optional()
    .transform((v) => (v === undefined ? undefined : sanitizeSummaryHtml(v))),
  benefits: z.array(benefitSchema).max(12).optional(),
  howToUse: z.array(stepSchema).max(12).optional(),
  faq: z.array(faqSchema).max(20).optional(),
  whyLoveTitle: z.string().trim().min(1).max(160).optional(),
  howToUseTitle: z.string().trim().min(1).max(160).optional(),
  ratingValue: z.string().trim().min(1).max(10).optional(),
  ratingCount: z.string().trim().min(1).max(20).optional(),
  trustBadges: z.array(badgeSchema).max(8).optional(),
  deliveryBadge: z.string().trim().max(160).optional(),
  ctaText: z.string().trim().min(1).max(120).optional(),
  heroAlt: z.string().trim().max(200).optional(),
});

export type ProductPageUpdate = z.infer<typeof productPageUpsertSchema>;

// A publish takes no body at all. The snapshot is assembled from what the rows
// already hold, so a body would only be a second, divergent way of saying what
// the page contains — and the two would eventually disagree.
export const publishRequestSchema = z.object({}).strict();

