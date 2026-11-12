// Local demo data so a fresh database is immediately usable: `npm run db:seed`.
//
// This is DATA, not schema, and it lives in a script rather than in
// migrations/0003_*.sql on purpose. The migration history is the same in every
// environment; seeding is a local convenience an operator runs on purpose.
// Running it twice is harmless, and so is running it against a database that
// already holds real rows: every statement is conditional.
//   node scripts/seed.mjs
// Media keys are absolute URLs rather than R2 keys: the storefront passes an
// http(s) value through untouched (see mediaUrl in shared/scripts/orchestrate.js),
// which is what lets a local demo look like a real product page with no uploads.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rootEnvPath = join(repoRoot, ".env");
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set DATABASE_URL (root .env or environment) before seeding.");
  process.exit(1);
}

const PRODUCT = {
  slug: "glow-serum",
  name: "Radiance Glow Serum",
  description:
    "A lightweight vitamin C and niacinamide serum that fades dark spots and evens skin tone in 14 days of consistent use.",
  price: 1500000, // kobo — ₦15,000
  seoTitle: "Radiance Glow Serum — Visible Results in 14 Days",
  seoDescription:
    "Fades dark spots, hyperpigmentation, and evens skin tone in 14 days. Pay on delivery in Lagos, Ogun, Enugu & Abuja.",
};

const IMAGES = [
  ["https://picsum.photos/seed/glow-serum-1/640/640", "Radiance Glow Serum bottle with dropper"],
  ["https://picsum.photos/seed/glow-serum-2/640/640", "Serum texture close-up"],
  ["https://picsum.photos/seed/glow-serum-3/640/640", "Glow Serum on a marble surface"],
];

const TESTIMONIALS = [
  ["https://picsum.photos/seed/face-1/96/96", "Amaka O.", "Two weeks and the dark spots on my cheeks had visibly faded. Pay on delivery made it easy to trust first."],
  ["https://picsum.photos/seed/face-2/96/96", "Bisi T.", "Light, no oily shine by midday, and my tone is more even. I already ordered a second bottle."],
];

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(
    `INSERT INTO products (slug, name, description, price, package_options, seo_title, seo_description)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, $5, $6)
     ON CONFLICT (slug) DO NOTHING`,
    [PRODUCT.slug, PRODUCT.name, PRODUCT.description, PRODUCT.price, PRODUCT.seoTitle, PRODUCT.seoDescription],
  );

  const { rows: [product] } = await client.query("SELECT id FROM products WHERE slug = $1", [PRODUCT.slug]);

  // product_images / testimonials have no natural unique key, so "already
  // there?" is the check rather than a constraint. Keyed on the image URL.
  for (const [index, [r2Key, altText]] of IMAGES.entries()) {
    await client.query(
      `INSERT INTO product_images (product_id, r2_key, display_order, alt_text)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM product_images WHERE r2_key = $2)`,
      [product.id, r2Key, index, altText],
    );
  }

  for (const [index, [r2Key, title, description]] of TESTIMONIALS.entries()) {
    await client.query(
      `INSERT INTO testimonials (product_id, kind, r2_key, title, description, display_order)
       SELECT $5, 'review', $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM testimonials WHERE r2_key = $1)`,
      [r2Key, title, description, index, product.id],
    );
  }

  // Discount tiers and payment rules already have defaults from the migrations;
  // only fill them in when the table is empty, so a real configuration is
  // never overwritten.
  // The page copy (summary, benefits, how-to, FAQ, trust badges). Without it a published demo page has
  // no content sections at all. Publishing creates an all-empty row on first use, so the row is filled
  // while it is still untouched (no summary, no list items) and left alone once an admin has edited it.
  // Shapes match validation/adminSchema.ts: benefits [{icon,title,body}], howToUse [{title,body}], faq [{q,a}].
  await client.query(
    `INSERT INTO product_pages (product_id, summary_html, benefits, how_to_use, faq, trust_badges, delivery_badge, hero_alt)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)
     ON CONFLICT (product_id) DO UPDATE SET
       summary_html = EXCLUDED.summary_html, benefits = EXCLUDED.benefits, how_to_use = EXCLUDED.how_to_use,
       faq = EXCLUDED.faq, trust_badges = EXCLUDED.trust_badges, delivery_badge = EXCLUDED.delivery_badge,
       hero_alt = EXCLUDED.hero_alt, updated_at = now()
     WHERE product_pages.summary_html = ''
       AND jsonb_array_length(product_pages.benefits) = 0
       AND jsonb_array_length(product_pages.how_to_use) = 0
       AND jsonb_array_length(product_pages.faq) = 0`,
    [
      product.id,
      "A fast-absorbing <strong>Vitamin C + Niacinamide</strong> serum designed for African skin. Fades hyperpigmentation, restores natural radiance and clears blemishes in just 14 days.",
      JSON.stringify([
        { icon: "check", title: "14-Day Dark Spot Clearance", body: "Visibly evens out stubborn dark spots, acne scars, and sun damage without peeling." },
        { icon: "shield", title: "Gentle On Melanin-Rich Skin", body: "No hydroquinone, no bleaching agents, safe for daily use." },
        { icon: "truck", title: "Free Delivery In Lagos & Ogun", body: "Order today and receive within 24-48 hours." },
        { icon: "check", title: "Risk-Free Cash On Delivery", body: "Open and verify your package before paying our trusted delivery dispatch." },
      ]),
      JSON.stringify([
        { title: "Cleanse", body: "Wash face with warm water and a gentle cleanser, then pat dry." },
        { title: "Apply", body: "Dispense 3-4 drops directly onto face and gently massage into skin." },
        { title: "Lock", body: "Follow with your favorite moisturizer and SPF sunscreen in the morning." },
      ]),
      JSON.stringify([
        { q: "How fast will I get my order?", a: "Orders in Lagos and Ogun arrive within 24-48 hours. Other states arrive in 2-4 business days." },
        { q: "Can I pay on delivery?", a: "Yes, in Lagos, Ogun, Enugu and Abuja for up to 4 items, and you may inspect the package before paying." },
        { q: "Will it bleach or lighten my skin tone?", a: "No. It contains zero hydroquinone or bleaching steroids. It only clears hyperpigmentation to reveal your natural glow." },
      ]),
      JSON.stringify([
        { icon: "shield", text: "Dermatologist tested" },
        { icon: "truck", text: "Pay on delivery available" },
        { icon: "check", text: "10,000+ happy customers" },
      ]),
      "Free delivery in Lagos & Ogun",
      "Bottle of Radiance Glow Serum",
    ],
  );

  const { rows: [tierCount] } = await client.query("SELECT count(*)::int AS n FROM discount_tiers");
  if (tierCount.n === 0) {
    await client.query(
      `INSERT INTO discount_tiers (min_quantity, discount_percent, label) VALUES
         (1, 0, NULL), (2, 10, 'Buy 2, save 10%'), (3, 20, 'Buy 3 or 4, save 20%'), (5, 25, 'Buy 5+, save 25%')`,
    );
    console.log("Inserted default discount tiers.");
  }

  console.log(`Seeded demo product "${PRODUCT.slug}" with ${IMAGES.length} images and ${TESTIMONIALS.length} testimonials.`);
  console.log("Pay on delivery is available for Lagos, Ogun, Enugu and Abuja up to 4 items (see payment_rules).");
} finally {
  await client.end();
}