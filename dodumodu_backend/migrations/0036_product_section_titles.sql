-- Product page section headings: one JSONB object (section_titles) becomes the
-- single source of truth for all eight H2 headings on the product storefront.
--
-- It replaces:
--   * the individually configured why_love_title / how_to_use_title columns
--   * the headings hardcoded in build/render-core.mjs and build/product.template.html
--
-- The legacy columns are kept: this is not a destructive change, and nothing in
-- the active code path reads them anymore. Existing customized heading values
-- remain in them untouched.
ALTER TABLE product_pages
  ADD COLUMN IF NOT EXISTS section_titles jsonb
    NOT NULL DEFAULT '{"benefits":"Why Nigerian Women Love This Serum","testimonials":"What customers say","whatsapp":"Real WhatsApp messages from customers","howToUse":"How To Use For Best Results","faq":"Frequently Asked Questions","middleCta":"Ready to place your order?","order":"Place your order now","finalCta":"Still thinking it over?"}';

-- Backfill every existing row without overwriting a customized legacy heading:
-- why_love_title / how_to_use_title feed benefits / howToUse only when they are
-- non-blank; every other key takes the same default wording a new row gets from
-- the column default. Re-running produces the same object (idempotent).
UPDATE product_pages
SET section_titles = jsonb_build_object(
  'benefits', COALESCE(NULLIF(trim(why_love_title), ''), 'Why Nigerian Women Love This Serum'),
  'testimonials', 'What customers say',
  'whatsapp', 'Real WhatsApp messages from customers',
  'howToUse', COALESCE(NULLIF(trim(how_to_use_title), ''), 'How To Use For Best Results'),
  'faq', 'Frequently Asked Questions',
  'middleCta', 'Ready to place your order?',
  'order', 'Place your order now',
  'finalCta', 'Still thinking it over?'
);
