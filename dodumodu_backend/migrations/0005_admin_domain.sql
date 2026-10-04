-- Admin domain: real categories, a delivery timestamp on orders, and the
-- indexes the admin lists actually query by.
--
-- Additive only: nothing here rewrites the meaning of an existing row, and no
-- statement drops or narrows anything 0000-0004 put in place. Each statement is
-- also written to survive a re-run, because a file interrupted half way through
-- can leave the schema ahead of the schema_migrations row that records it.

-- ---------------------------------------------------------------------------
-- Categories
--
-- The catalogue has exactly one category today and it lives nowhere: it is a
-- string that the storefront, the admin panel and whoever writes the next
-- product each have to remember independently. Making it a row is what lets a
-- second product exist without those three drifting, and it is the same row a
-- category listing or a homepage filter would read later.
--
-- parent_id is nullable and self-referential so a flat catalogue and a nested
-- one are the same table instead of a redesign later. ON DELETE SET NULL there
-- is deliberate: retiring a parent must never take its children with it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  media_r2_key TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  -- A slug is a URL segment, so it is validated where it is written rather than
  -- assumed by everyone who later renders it. Same shape products already use.
  CONSTRAINT categories_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- A cycle of length one is a category inside itself. Longer cycles need to
  -- look at other rows, which a CHECK cannot do, so the service catches those.
  CONSTRAINT categories_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT categories_name_length CHECK (char_length(name) BETWEEN 1 AND 120)
);

-- Both reads are "categories in sort order, optionally narrowed to one parent or
-- to the visible ones": the admin table, and a customer listing later. The slug
-- lookup is served by the UNIQUE constraint's own index already.
CREATE INDEX IF NOT EXISTS idx_categories_parent_sort ON categories (parent_id, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_categories_active_sort ON categories (is_active, sort_order, name);

-- ---------------------------------------------------------------------------
-- Product to category
--
-- Nullable with ON DELETE SET NULL even though the rule is "a product has a
-- category", for two reasons:
--   - NOT NULL would have to arrive as add-column, backfill, then set-not-null,
--     and three steps is three chances for an environment to sit half migrated;
--     the backfill below runs in this same transaction, so the column is already
--     populated the moment it exists;
--   - SET NULL is the database-level half of "deleting a category never silently
--     moves or destroys products". The service refuses that delete while any
--     product still points at the category; this guarantees the same outcome
--     even if a future code path forgets the check.
-- The requirement itself is enforced in productService, the one place able to
-- tell the person who just saved what to do about it.
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;

-- The product list narrows by category and orders by name. Joining the category
-- name itself is a primary-key lookup and needs no index of its own.
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products (category_id, active, name);

-- ---------------------------------------------------------------------------
-- Delivery timestamp
--
-- NULL means "not delivered", the only honest way to say it: a sentinel date
-- would be a date nobody chose. Written by the server when an order is marked
-- delivered and cleared again if that is reverted, so a browser is never the
-- source of either value.
-- ---------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;

-- The admin order list is always "newest first, optionally narrowed, always
-- paged", so the sort and the equality filters are what earn an index.
-- (status, created_at) has existed since 0000 and still covers the status filter.
CREATE INDEX IF NOT EXISTS idx_orders_created_at_desc ON orders (created_at DESC);
-- Phone search is a prefix match, which a plain btree index serves. A search for
-- digits typed from the middle of a number cannot use it, and that is stated
-- rather than pretended away.
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders (phone);
-- "Which pay-on-delivery orders are still outstanding" is the operational
-- question asked most from this screen, and it narrows on both columns at once.
CREATE INDEX IF NOT EXISTS idx_orders_method_status ON orders (payment_method, status);

-- Testimonials are read per product, restricted to the visible ones, in display
-- order. 0004 indexed (product_id, display_order) without visibility, which
-- still serves this; the extra index matches the filter the query really has.
CREATE INDEX IF NOT EXISTS idx_testimonials_product_active ON testimonials (product_id, active, display_order);

-- ---------------------------------------------------------------------------
-- The category that already exists in the business
--
-- Data, not schema, in the one place it belongs: without it the column is null
-- in every environment and "products belong to a category" is untrue on arrival.
-- This is not seeding a demo product - that stays in scripts/seed.mjs, which an
-- operator runs on purpose. It names the group the existing products are already
-- in, so it ships together with the column that points at it.
-- ---------------------------------------------------------------------------
INSERT INTO categories (name, slug, description, sort_order)
VALUES (
  'Skin Cares',
  'skin-cares',
  'Serums, creams and treatments for everyday skincare routines.',
  0
)
ON CONFLICT (slug) DO NOTHING;

UPDATE products
  SET category_id = (SELECT id FROM categories WHERE slug = 'skin-cares')
  WHERE category_id IS NULL;

-- ---------------------------------------------------------------------------
-- The media registry
--
-- Every upload already lands in object storage through POST /admin/media and
-- comes back with a key. What existed nowhere is the record that a key was ever
-- issued. Without it, a key that has stopped being referenced by any product,
-- category or testimonial cannot be found at all, "what is this image used for"
-- cannot be answered without asking every table what it happens to point at, and
-- an orphaned object is invisible forever.
--
-- r2_key is UNIQUE because the key is the identity: the same bytes at the same
-- address are one object, and two rows for it would be two answers to "is this in
-- use" - which is the one question this table exists to answer.
--
-- product_id is nullable and deliberately not authoritative. It records what the
-- uploader said they were uploading for, which is what makes the unattached
-- filter useful. The truth about who references an image is still the reference
-- query in mediaRepo, read live, because a product can be edited minutes later.
--
-- Nothing here stores bytes or duplicates dimensions that product_images already
-- carries. This is an index of what was handed out, not a second copy of the
-- catalogue.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media (
  id SERIAL PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  uploaded_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT media_key_length CHECK (char_length(r2_key) BETWEEN 1 AND 400),
  CONSTRAINT media_byte_size CHECK (byte_size >= 0),
  CONSTRAINT media_dimensions CHECK (
    (width IS NULL OR width BETWEEN 1 AND 20000)
    AND (height IS NULL OR height BETWEEN 1 AND 20000)
  )
);

-- The library is always "newest first, paged"; the by-product view narrows on
-- product_id. Both are covered by their own index rather than one hopeful one.
CREATE INDEX IF NOT EXISTS idx_media_created_at ON media (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_product ON media (product_id);
