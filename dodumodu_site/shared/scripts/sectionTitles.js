// The single source of truth for the eight product-page section headings.
// Stable keys (not display text) so an admin can reword any heading without
// touching the build. Consumed by the renderer (build/render-core.mjs) and the
// admin page editor (shared/scripts/admin/views/products.js); both bundles are
// separate so the values live here, in one place, rather than being copied.
export const DEFAULT_SECTION_TITLES = {
  benefits: 'Why Nigerian Women Love This Serum',
  testimonials: 'What customers say',
  whatsapp: 'Real WhatsApp messages from customers',
  howToUse: 'How To Use For Best Results',
  faq: 'Frequently Asked Questions',
  middleCta: 'Ready to place your order?',
  order: 'Place your order now',
  finalCta: 'Still thinking it over?',
};

export const SECTION_TITLE_KEYS = [
  'benefits',
  'testimonials',
  'whatsapp',
  'howToUse',
  'faq',
  'middleCta',
  'order',
  'finalCta',
];
