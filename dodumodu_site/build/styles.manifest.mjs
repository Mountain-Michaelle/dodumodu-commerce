// The canonical stylesheet order.
//
// Shared by build/bundle.mjs and by test/css-single-source.mjs, so the test
// rebuilds the sheet with exactly the inputs the build used instead of
// repeating a list that could quietly stop matching.
//
// Order is load-bearing: tokens.css first because every later sheet reads its
// custom properties, product.css near the end because it is page chrome refining
// the shared sheets without needing !important, and brand.css LAST because it
// refines header/footer chrome over everything else - which is exactly the
// cascade position its former after-the-sheet inline block had.
// brand-motion.css (the logo keyframes) sits right before brand.css so logo
// sizing wins the cascade, and is ALSO appended to ADMIN_STYLES below so the
// splash + top-bar animations reach the admin bundle too.
export const SITE_STYLES = [
  "tokens.css",
  "base.css",
  "layout.css",
  "form.css",
  "pricing.css",
  "carousel.css",
  "testimonials.css",
  "product.css",
  "brand-motion.css",
  "brand.css",
  "sticky.css",  
];

// The admin console ships its own sheet and never the customer bundle's.
// brand-motion.css is shared: the logo keyframes must reach the admin
// (splash + top-bar activity light) as well as the site pages.
export const ADMIN_STYLES = ["admin.css", "brand-motion.css"];
