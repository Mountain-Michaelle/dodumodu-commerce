-- Product CMS: page content becomes product-scoped rows that cascade with
-- their product, and publishing records an immutable snapshot the static
-- build renders from. Saving edits never changes what customers see; only a
-- publish does.

-- One content row per product: the sections that used to live hardcoded in
-- products/<slug>/index.html (benefit cards, how-to-use steps, FAQ, summary).
CREATE TABLE product_pages (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  summary_html TEXT NOT NULL DEFAULT '',
  benefits JSONB NOT NULL DEFAULT '[]',      -- icon/title/body objects
  how_to_use JSONB NOT NULL DEFAULT '[]',    -- title/body objects
  faq JSONB NOT NULL DEFAULT '[]',           -- q/a objects
  why_love_title TEXT NOT NULL DEFAULT 'Why Nigerian Women Love This Serum',
  how_to_use_title TEXT NOT NULL DEFAULT 'How To Use For Best Results',
  rating_value TEXT NOT NULL DEFAULT '4.9',
  rating_count TEXT NOT NULL DEFAULT '1,048',
  trust_badges JSONB NOT NULL DEFAULT '[]',  -- icon/text objects
  delivery_badge TEXT NOT NULL DEFAULT '',
  cta_text TEXT NOT NULL DEFAULT 'Place your order now',
  hero_alt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Images carry the renditions responsive markup needs. The contract the page
-- renders from (r2_key + variants + width/height) stays independent of how
-- the bytes were made: a browser canvas today, a transform service later.
ALTER TABLE product_images
  ADD COLUMN width INTEGER,
  ADD COLUMN height INTEGER,
  ADD COLUMN variants JSONB NOT NULL DEFAULT '[]';

-- Cascade with the product (0000 only referenced it).
ALTER TABLE product_images DROP CONSTRAINT product_images_product_id_fkey;
ALTER TABLE product_images ADD CONSTRAINT product_images_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;

-- Testimonials are product content now, split into two presentation kinds:
-- a written review card vs. a WhatsApp screenshot.
ALTER TABLE testimonials
  ADD COLUMN product_id INTEGER,
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'review',
  ADD COLUMN width INTEGER,
  ADD COLUMN height INTEGER,
  ADD COLUMN variants JSONB NOT NULL DEFAULT '[]';

-- Backfill: this storefront has one product; every existing row belongs to it.
UPDATE testimonials SET product_id = (SELECT id FROM products ORDER BY id LIMIT 1)
  WHERE product_id IS NULL;
ALTER TABLE testimonials ALTER COLUMN product_id SET NOT NULL;
ALTER TABLE testimonials ADD CONSTRAINT testimonials_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE testimonials ADD CONSTRAINT testimonials_kind_check
  CHECK (kind IN ('review', 'whatsapp'));

CREATE INDEX idx_testimonials_product_id ON testimonials (product_id, display_order);

-- Publish snapshots: one immutable JSON payload per publish, assembled from
-- the live rows at publish time. The static build renders ONLY these, so a
-- draft edit sitting in product_pages cannot reach customers, and every
-- product in one build comes from a single consistent capture instead of a
-- live-table read that could straddle two admin saves.
CREATE TABLE product_publishes (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  published_by TEXT NOT NULL,
  build_status TEXT NOT NULL DEFAULT 'triggered',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_publishes_product_id ON product_publishes (product_id, id DESC);

-- A written review has no screenshot, so r2_key becomes optional here: an
-- empty string means the card is text only.
ALTER TABLE testimonials ALTER COLUMN r2_key SET DEFAULT '';
