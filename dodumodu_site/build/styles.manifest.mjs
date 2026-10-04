// The canonical stylesheet order.
//
// Shared by build/bundle.mjs and by test/css-single-source.mjs, so the test
// rebuilds the sheet with exactly the inputs the build used instead of
// repeating a list that could quietly stop matching.
//
// Order is load-bearing: tokens.css first because every later sheet reads its
// custom properties, and product.css last because it is page chrome refining
// the shared sheets without needing !important.
export const SITE_STYLES = [
  "tokens.css",
  "base.css",
  "layout.css",
  "form.css",
  "pricing.css",
  "carousel.css",
  "testimonials.css",
  "product.css",
];

// The admin console ships its own sheet and never the customer bundle's.
export const ADMIN_STYLES = ["admin.css"];
