// Proves the product page's CSS has exactly one source of truth: shared/styles.
//
//   node build/bundle.mjs && node test/css-single-source.mjs
//
// Why this file exists: the page used to carry a hand-maintained COPY of the
// stylesheet so that opening it off disk (file://) still looked right, and that
// copy went stale in ways nothing caught - the page width, the form-control
// styling and the whole Turnstile visibility contract existed only there. So a
// designer reviewing the source file was reviewing something customers were
// never served, and the built page and the preview disagreed.
//
// The build now regenerates the inline block from shared/styles and drops it
// from dist. That is only correct if the generated block really is the shared
// sheet, so this rebuilds the sheet from the same manifest the build uses and
// compares the two byte for byte rather than trusting that they agree.
//
// It runs AFTER the build on purpose: the invariant under test is "the page
// carries the current sheet", which can only be true once the build has
// regenerated it. A hand-edit to the inline block therefore fails here.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { SITE_STYLES } from "../build/styles.manifest.mjs";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const distDir = join(siteRoot, "dist");
const sourcePage = join(siteRoot, "products/glow-serum/index.html");

if (!existsSync(distDir)) {
  console.error("dist/ not found - run `node build/bundle.mjs` first.");
  process.exit(1);
}

let failures = 0;
const ok = (label, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${extra ? "  -> " + extra : ""}`);
  if (!pass) failures++;
};

/* ---- Rebuild the canonical sheet exactly as build/bundle.mjs does ----
   The esbuild options are duplicated deliberately: if the build changes how it
   minifies, this fails and the two are reconciled, instead of the test quietly
   comparing against a different pipeline than the one that ships. */
const concatenated = SITE_STYLES
  .map((file) => readFileSync(join(siteRoot, "shared", "styles", file), "utf8"))
  .join("\n");
const { outputFiles } = await build({
  stdin: { contents: concatenated, loader: "css" },
  write: false,
  minify: true,
});
const canonical = outputFiles[0].text;

/* Two spellings of one selector are the same selector: esbuild drops the quotes
   in [name="quantity"] and writes :after for ::after. Matching is done on whole
   rule blocks rather than on text, because a selector can appear in several
   rules (.field textarea is both a font rule and a sizing rule) and can also be
   one part of a group (.field[data-invalid=true] input,.… select,…) - both are
   normal ways for a declaration to be present. */
const cssNorm = (value) => value.replace(/::/g, ":").replace(/["']/g, "").replace(/\s+/g, " ").trim();
const ruleHas = (css, selector, needle) => {
  const want = cssNorm(selector);
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
    ([, sel, body]) => cssNorm(sel).split(",").some((part) => part.trim() === want) && body.includes(needle),
  );
};

console.log("CSS single source - the page must carry shared/styles, not a copy of it:\n");

/* ---------- 1. the source page ---------- */
const sourceHtml = readFileSync(sourcePage, "utf8");
const sourceStyles = [...sourceHtml.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
// The block is written as `<style>\n…\n</style>`, so the capture carries the
// newlines the build put around the sheet. Compare the sheet, not the padding.
const pageCss = (sourceStyles[0] || "").trim();

ok("source page has exactly one <style> block", sourceStyles.length === 1, `${sourceStyles.length} found`);
ok(
  "source <style> is marked as generated (edit shared/styles, not this file)",
  sourceHtml.includes("GENERATED from shared/styles"),
);
ok(
  "source <style> is the shared stylesheet, byte for byte",
  pageCss === canonical.trim(),
  `page ${pageCss.length}B vs shared ${canonical.trim().length}B`,
);
// Minification strips every comment, so a hand-maintained block would still
// carry its section comments. This is the check that catches "someone edited
// the page's CSS again".
ok("source <style> is not a stale hand-written copy", sourceStyles[0]?.includes("/*") === false);

/* ---------- 2. the built page ---------- */
const distPage = join(distDir, "products/glow-serum/index.html");
const distHtml = readFileSync(distPage, "utf8");
const siteCssFile = readdirSync(distDir).find((f) => /^site\..*\.min\.css$/.test(f));
ok("hashed site stylesheet was emitted", Boolean(siteCssFile), siteCssFile || "none found");

const linkedHref = (distHtml.match(/<link rel="stylesheet" href="([^"]+)"/) || [])[1];
ok("dist page links the hashed stylesheet", linkedHref === `/${siteCssFile}`, String(linkedHref));

// The whole point of dropping the block: the link serves the same bytes, so a
// second copy inside the document would be pure download weight.
ok("dist page ships no duplicate copy of the stylesheet", !/<style[\s>]/.test(distHtml),
  distHtml.match(/<style[\s>][\s\S]{0,40}/)?.[0] || "no <style> at all");

const servedCss = readFileSync(join(distDir, siteCssFile), "utf8");
ok("served stylesheet is the shared stylesheet, byte for byte", servedCss === canonical);

/* The strongest statement available: the preview and the served page are not
   merely "equivalent", they are the same CSS, so no rule can differ between
   the file a designer opens and the file a customer downloads. */
ok("preview and served page are the same stylesheet", cssNorm(pageCss) === cssNorm(servedCss));

/* ---------- 3. the form and Turnstile contract ---------- */
/* The rules whose drift actually reached customers. Each must survive in the
   one canonical sheet: if shared/styles loses a rule the page used to have,
   this is where it shows - on the preview and on the served page alike. */
const CONTRACT = [
  [".order-form", "max-width:520px"],
  [".order-form", "gap:7px"],
  [".field-row", "gap:7px"],
  [".field", "gap:6px"],
  [".radio-group", "gap:5px"],
  [".field-error", "min-height:1em"],
  [".field textarea", "resize:none"],
  [".field textarea", "min-height:96px"],
  [".field[data-invalid=true] input", "border-color"],
  [".quantity-stepper input[name=quantity]", "text-align:center"],
  [".submit-button[data-loading=true]:after", "animation:"],
  [".radio-option:has(input:checked)", "border-color"],
  [".quantity-price-tier[data-active=true]", "font-weight:700"],
];

for (const [selector, declaration] of CONTRACT) {
  ok(`${selector} { ${declaration} } survives in the shared sheet`, ruleHas(canonical, selector, declaration));
}

/* The Turnstile container is display:none until Cloudflare sets data-ready, and
   these two rules used to live ONLY in the page's inline copy - so the served
   page shipped without them. They belong to shared/styles now. */
ok("Turnstile stays hidden until Cloudflare renders it", ruleHas(canonical, ".cf-turnstile", "display:none"));
ok("Turnstile is revealed once it is ready", ruleHas(canonical, '.cf-turnstile[data-ready="true"]', "display:block"));

const productCss = readFileSync(join(siteRoot, "shared", "styles", "product.css"), "utf8");
ok("the Turnstile visibility contract lives in shared/styles, not in the page",
  /\.cf-turnstile \{[^}]*display: none/.test(productCss)
  && /\.cf-turnstile\[data-ready="true"\] \{ display: block; \}/.test(productCss));

console.log(
  `\n${failures === 0 ? "OK" : "FAILED"}  ${canonical.length}B of CSS, one copy in shared/styles, `
  + `${sourceStyles[0]?.length ?? 0}B inline for the file:// preview, 0B duplicated in dist`,
);
process.exit(failures === 0 ? 0 : 1);
