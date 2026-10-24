// Build budget: fails when the page gets heavier than the ceiling below.
//
//   node build/bundle.mjs && node test/size-budget.mjs
//
// Why this file exists: every "it's faster now" change is a change someone can
// quietly undo in a later commit. These numbers are the ceiling - a feature that
// does not fit gets smaller, not the ceiling gets raised.
//
// The budget is measured in GZIPPED bytes, not raw ones, because that is what
// crosses the network: Cloudflare gzips in front of the site, and 40 KB of
// readable HTML is 9 KB of waiting for a customer on a poor connection. Raw
// bytes are printed next to it so a regression is still diagnosable.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

if (!existsSync(distDir)) {
  console.error("dist/ not found - run `node build/bundle.mjs` first.");
  process.exit(1);
}

// Wire-byte ceilings, with roughly 15% headroom for the next small feature.
const BUDGETS = {
  page: 10.5 * 1024,   // HTML document, preview script included (CSS is linked)
  css: 4.7 * 1024,     // the whole stylesheet (includes brand-motion.css keyframes)
  js: 7.0 * 1024,      // the whole customer bundle
  // Everything the first paint needs, excluding the hero image (which is a
  // separate, cacheable, content-negotiated request). This is the number that
  // decides whether a customer on a poor connection sees the product.
  criticalPath: 22 * 1024,
};

// The built page carries NO inline CSS: the source page's <style> is generated
// from shared/styles for the file:// preview, and dist drops it because the
// <link> serves those exact bytes (see "One stylesheet, one copy" in
// build/bundle.mjs). These selectors must still style the first screen, so the
// check is "present in the linked sheet" - and the page's own copy is allowed
// to satisfy it, never required to.
const CRITICAL_SELECTORS = [
  ".page", ".product-layout", "#carousel", ".site-header", ".breadcrumbs",
  ".order-form", ".field", ".quantity-stepper", ".submit-button",
  ".radio-option", ".site-footer", ".section", "h1", "h2",
];

// Every name the app, the API payload and the UX tests depend on must survive
// the rewrite - a minifier that eats a form field is a lost order.
const CONTRACTS = [
  'id="order-form"', 'name="quantity"', 'id="quantity-stepper"', 'id="quantity-price"',
  'name="customerName"', 'name="phone"', 'name="whatsapp"', 'name="address"',
  'name="state"', 'name="deliveryDate"', 'name="paymentMethod"', 'name="questionNotes"',
  'name="turnstileToken"', 'id="cod-hint"', 'id="late-warning"', 'id="retry-banner"',
  'id="manual-retry-button"', 'id="carousel"', 'id="testimonials"', 'id="price-breakdown"',
  'data-action="increment"', 'data-action="decrement"', 'value="cod"', 'value="pay_now"',
  "<option>Enugu</option>", "data-sitekey=",
];

let failures = 0;
const kb = (bytes) => (bytes / 1024).toFixed(1).padStart(6) + " KB";

/** The budget applies to the gzip figure; raw is printed for diagnosis. */
function measure(label, file, budget) {
  const raw = readFileSync(file);
  const gz = gzipSync(raw, { level: 9 }).length;
  const pass = gz <= budget;
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label.padEnd(28)} ${kb(gz)} wire ${kb(raw.length)} raw  budget ${kb(budget).trim()}`,
  );
  return { raw, gz };
}

/** Same measurement, but silent apart from the verdict - for a summed total. */
function sizeOf(file) {
  const raw = readFileSync(file);
  return { raw: raw.length, gz: gzipSync(raw, { level: 9 }).length };
}

console.log("Size budget — the wire (gzip) column is what the budget applies to:\n");

const files = readdirSync(distDir);
const siteCssFile = files.find((f) => /^site\..*\.min\.css$/.test(f));
const siteJsFile = files.find((f) => /^site\..*\.min\.js$/.test(f));

if (!siteCssFile || !siteJsFile) {
  console.error("FAIL  hashed site bundles not found in dist/");
  process.exit(1);
}

const page = measure("products/glow-serum/index.html", join(distDir, "products/glow-serum/index.html"), BUDGETS.page);
const css = measure("site CSS (minified)", join(distDir, siteCssFile), BUDGETS.css);
const js = measure("site JS (minified)", join(distDir, siteJsFile), BUDGETS.js);

// The number that actually decides whether a customer on a poor connection sees
// the product: the document, the stylesheet and the script. The hero image is
// excluded on purpose — it is one separate, cacheable, size-negotiated request,
// and its weight is governed by the srcset candidates on the page.
const critical = page.gz + css.gz + js.gz;
console.log(
  `${critical <= BUDGETS.criticalPath ? "PASS" : "FAIL"}  ${"first paint (no hero image)".padEnd(28)} ${kb(critical)} wire               budget ${kb(BUDGETS.criticalPath).trim()}`,
);
if (critical > BUDGETS.criticalPath) failures++;

/* ---- Correctness of the slimming, not just its size ---- */
const html = page.raw.toString("utf8");
const linkedCss = readFileSync(join(distDir, siteCssFile), "utf8");
const inlineStyle = (html.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];

const styled = CRITICAL_SELECTORS.filter((s) => inlineStyle.includes(s) || linkedCss.includes(s));
for (const missing of CRITICAL_SELECTORS.filter((s) => !styled.includes(s))) {
  console.log(`FAIL  critical selector ${missing} is in neither the page nor its stylesheet`);
  failures++;
}
console.log(`\n${styled.length}/${CRITICAL_SELECTORS.length} critical selectors still style the first screen`);

// The JSON-LD must survive verbatim: it is the product's rich-result data, and
// the preview price reads its offer, so a mangled copy breaks both.
const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
if (!ld) {
  console.log("FAIL  JSON-LD block missing from the built page");
  failures++;
} else {
  try {
    const graph = JSON.parse(ld[1])["@graph"] || [];
    const product = graph.find((n) => n["@type"] === "Product");
    const hasFaq = graph.some((n) => n["@type"] === "FAQPage");
    const ok = Boolean(product?.offers?.price) && hasFaq;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  JSON-LD intact (Product offer ${product?.offers?.price}, ${hasFaq ? "FAQPage present" : "FAQPage MISSING"})`);
  } catch (err) {
    failures++;
    console.log(`FAIL  JSON-LD no longer parses: ${err.message}`);
  }
}

const dropped = CONTRACTS.filter((c) => !html.includes(c));
for (const contract of dropped) {
  console.log(`FAIL  the build dropped a form contract: ${contract}`);
  failures++;
}
console.log(`${CONTRACTS.length - dropped.length}/${CONTRACTS.length} form contracts intact in the built page`);

// No unhashed asset URL may reach production, or the cache headers would pin a
// file for a year under a name the next deploy will change.
const stale = html.match(/(?:src|href)="(?!https?:|#|tel:|mailto:|data:|\/)([^"]*\.(?:css|js))"/g) || [];
const placeholders = html.match(/__(?:SITE|ADMIN)_(?:CSS|JS)__/g) || [];
if (stale.length || placeholders.length) {
  console.log(`FAIL  unhashed/placeholder asset URLs shipped: ${[...stale, ...placeholders].join(", ")}`);
  failures++;
} else {
  console.log("PASS  every shipped asset URL is content-hashed (safe to cache for a year)");
}

// Turnstile must not be back in the critical path: it is loaded on demand by
// shared/scripts/turnstile.js, never by a <script src> in the document.
const eagerTurnstile = /<script[^>]+src="[^"]*challenges\.cloudflare\.com/i.test(html);
if (eagerTurnstile) {
  console.log("FAIL  Turnstile is back in an eager <script src> - it must load on demand");
  failures++;
} else {
  console.log("PASS  Turnstile is not in the critical path (loaded on demand)");
}

/* ------------------------------------------------------------------ admin */

// The admin console has its own ceiling, and a much larger one than a customer's
// because it is not on a customer's critical path: nobody on a 3G connection is
// waiting for an order table, and this sheet ships only to /admin/*.
//
// 300 KB is a generous bound that still fails the build if somebody reaches for a
// framework. The RAW total is the number checked - the strictest reading, since a
// framework that fits gzipped is still a heavy download on a LAN.
const ADMIN_BUDGET = 300 * 1024;

const adminCss = files.find((f) => /^admin\..*\.min\.css$/.test(f));
const adminJs = files.find((f) => /^admin\..*\.min\.js$/.test(f));
if (!adminCss || !adminJs) {
  console.error("FAIL  hashed admin bundles not found in dist/");
  process.exit(1);
}

const adminParts = [
  sizeOf(join(distDir, adminJs)),
  sizeOf(join(distDir, adminCss)),
  sizeOf(join(distDir, "admin/index.html")),
];
const adminTotal = adminParts.reduce(
  (acc, part) => ({ raw: acc.raw + part.raw, gz: acc.gz + part.gz }),
  { raw: 0, gz: 0 },
);
const adminOk = adminTotal.raw <= ADMIN_BUDGET;
if (!adminOk) failures++;
console.log(
  `${adminOk ? "PASS" : "FAIL"}  ${"admin total (raw)".padEnd(28)} ${kb(adminTotal.gz)} wire ${kb(adminTotal.raw)} raw  budget ${kb(ADMIN_BUDGET).trim()}`,
);
console.log(`      (js ${kb(adminParts[0].raw).trim()}, css ${kb(adminParts[1].raw).trim()}, html ${kb(adminParts[2].raw).trim()})`);

// The customer bundle must not have grown. This is the guard on the whole premise
// that admin work is free for the storefront: if shared code ever leaked from the
// admin entry into the customer one, these hashes would change and every customer
// would pay for it.
//
// Both hashes are produced by the build; the pin is the value the build emits.
// Rebuild the branch with `npm run test:size` whenever the sheet
// (tokens/base/layout/form/pricing/carousel/testimonials/product/brand-motion/brand)
// changes, then re-pin the CSS hash to the new output so the storefront CSS is
// never silently dropped by an admin change.
const EXPECTED_CUSTOMER = { js: "site.5e56fc15.min.js", css: "site.d9a793ed.min.css" };
for (const [kind, expected] of Object.entries(EXPECTED_CUSTOMER)) {
  const actual = kind === "js" ? siteJsFile : siteCssFile;
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  customer ${kind} unchanged by admin work  ${actual}`);
}

console.log(failures === 0 ? "\nSIZE BUDGET OK" : `\n${failures} SIZE BUDGET CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);