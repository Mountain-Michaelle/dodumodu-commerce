// Build-time only — never runs at request time in production (§6, Step 0).
// Cloudflare Pages runs this via `node build/bundle.mjs` with output dir `site/dist`.
import { build } from "esbuild";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_STYLES, SITE_STYLES } from "./styles.manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(__dirname, "..");
const repoRoot = join(siteRoot, "..");
const sharedDir = join(siteRoot, "shared");
const distDir = join(siteRoot, "dist");

/* ------------------------------------------------------------------
 * Environment.
 *
 * One .env at the repository root serves both packages. The backend reads it
 * at boot; this build reads it here, at build time, and nothing else — the
 * shipped source contains no URLs and no keys of its own.
 *
 * Real environment variables always win over the file (loadEnvFile never
 * overwrites them), which is exactly what Cloudflare Pages does: it sets
 * SITE_URL, API_BASE, TURNSTILE_SITE_KEY and IMAGE_DELIVERY_BASE as project
 * environment variables and there is no .env in the build at all. The same
 * build therefore serves local development and production, differing only in
 * configuration — never in code.
 *
 * Defaults are the pre-config values, so a build with no .env still produces a
 * working (placeholder) site rather than an empty one.
 * ------------------------------------------------------------------ */

const rootEnvPath = join(repoRoot, ".env");
const loadedEnvFile = existsSync(rootEnvPath);
if (loadedEnvFile) process.loadEnvFile(rootEnvPath);

const trimSlash = (value) => value.replace(/\/+$/, "");
const config = {
  // Canonical origin for <link rel=canonical>, og:url, JSON-LD, sitemap, robots.
  siteUrl: trimSlash(process.env.SITE_URL || "https://yoursite.com"),
  // Where the storefront calls the API. Empty means "same origin" — the local
  // dev server serves both, and so does a Worker route on your own domain.
  apiBase: trimSlash(process.env.API_BASE ?? ""),
  // Where images are fetched from. Local: the /media/* the dev server serves
  // from MEDIA_DIR. Production: the R2 custom domain.
  imageDeliveryBase: trimSlash(process.env.IMAGE_DELIVERY_BASE || "/media"),
  // Empty disables the widget: the page then ships an empty sitekey and
  // turnstile.js skips the challenge instead of loading a script that cannot
  // be solved. Only ever empty locally.
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY ?? "",
  // Placeholder imagery for the hero and the static testimonials.
  placeholderImageBase: trimSlash(process.env.PLACEHOLDER_IMAGE_BASE || "https://picsum.photos"),
  /**
   * The publish id this build renders from, as the `pub_<id>` version marker.
   *
   * Empty means "no publish has been built into this page", and the marker ships
   * blank. That is honest rather than broken: the admin's deployment check reads
   * the marker off the live page, and a page with no marker reports "not verified"
   * instead of claiming to be a version it is not.
   *
   * The prerender sets this per product. Until then it comes from the environment,
   * so a hand-run local build can prove the whole check end to end by setting it.
   */
  storefrontPublishId: normalisePublishVersion(process.env.STOREFRONT_PUBLISH_ID),
};

/**
 * Accepts either a bare publish id or an already-prefixed version and returns the
 * `pub_<id>` form.
 *
 * The prefix is added HERE rather than expected from the environment because the
 * two sides must agree exactly: publishService.publishVersion() produces `pub_6`,
 * and a build that emitted `6` would produce a page the verifier reads as "some
 * version, but not the one I am looking for" - so every live page would report as
 * deploying forever, with no clue why.
 */
function normalisePublishVersion(value) {
  const raw = (value ?? "").trim();
  if (raw === "") return "";
  return /^\d+$/.test(raw) ? `pub_${raw}` : raw;
}

// The only two values the runtime needs, injected into each page as a tiny
// inline script. They are public by definition (they are already in the HTML
// and in the requests) — no secret is ever placed in a build or a bundle.
function runtimeConfigScript() {
  return `<script>window.API_BASE=${JSON.stringify(config.apiBase)};window.IMAGE_DELIVERY_BASE=${JSON.stringify(config.imageDeliveryBase)}</script>`;
}

function hashOf(content) {
  return createHash("sha1").update(content).digest("hex").slice(0, 8);
}

function cleanDist() {
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
}

/** Concatenate CSS files in the given order, minify, write a content-hashed file. */
/**
 * Concatenate the shared sheets, minify, write a content-hashed file, and hand
 * back the exact bytes that were written. Those same bytes become the source
 * page's inline <style> (see writeSourceStyle), which is what makes the file://
 * preview and the built site one stylesheet rather than two.
 */

async function bundleCss(fileNames, outBaseName) {
  const concatenated = fileNames
    .map((f) => readFileSync(join(sharedDir, "styles", f), "utf8"))
    .join("\n");
  const result = await build({
    stdin: { contents: concatenated, loader: "css" },
    write: false,
    minify: true,
  });
  const minified = result.outputFiles[0].text;
  const filename = `${outBaseName}.${hashOf(minified)}.min.css`;
  writeFileSync(join(distDir, filename), minified);
  return { filename, minified };
}

/** Bundle from a single entry (its import graph IS the dependency order), minify, hash. */
async function bundleJs(entryFileName, outBaseName) {
  const result = await build({
    entryPoints: [join(sharedDir, "scripts", entryFileName)],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2019"],
    write: false,
  });
  const minified = result.outputFiles[0].text;
  const filename = `${outBaseName}.${hashOf(minified)}.min.js`;
  writeFileSync(join(distDir, filename), minified);
  return filename;
}

function walkHtmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkHtmlFiles(full));
    else if (entry.endsWith(".html")) out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------------
 * One stylesheet, one copy.
 *
 * The page has to work two ways: opened straight off disk, and served by
 * Cloudflare. Opened off disk it cannot resolve /__SITE_CSS__ - that is a
 * build placeholder, and without a build there is no hashed sheet to fetch -
 * so the source page carries the CSS inline. Otherwise the preview a designer
 * opens is unstyled, and "looks right here, looks wrong once deployed" stops
 * being catchable before shipping.
 *
 * That inline block used to be a second, hand-maintained copy, and that is
 * exactly how it drifted: the page width, the form-control styling and the
 * whole Turnstile visibility contract existed only there, so what you reviewed
 * was not what customers were served. So the build no longer compares two
 * copies and guesses which rules the other one covers - matching a selector
 * text proves nothing about matching declarations, which is how `.cf-turnstile`
 * kept a `display:none` in the page and no `display:none` in the sheet. It
 * generates the copy instead:
 *
 *   - The source page's <style> is rewritten from shared/styles, byte for byte
 *     the string written to the hashed sheet. Editing a shared stylesheet is
 *     the only way to change how the product looks, and the next build proves
 *     it by rewriting the page. Two builds in a row produce no second diff,
 *     because generation is a pure function of shared/styles.
 *   - dist drops the inline block entirely. The <link> already serves those
 *     exact bytes, so a second copy in the document buys nothing and costs
 *     real weight: 16 KB of CSS inlined would put the page over its gzip
 *     budget, while dropping it puts it well under.
 *
 * Only pages whose styles ARE the shared sheet are treated this way. A page
 * that styles itself (thank-you.html) keeps its own inline CSS, minified.
 * ------------------------------------------------------------------ */

/**
 * Owns the generated block. The build matches on this marker so a re-run
 * replaces the block instead of stacking a second one inside it, and so the
 * next person to open the source file knows the block is not theirs to edit.
 */
const GENERATED_CSS_NOTE =
  "<!-- GENERATED from shared/styles by build/bundle.mjs - edit shared/styles/*.css, then rebuild. -->";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Collapse runs of whitespace that carry no meaning in a <style>. */
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")          // comments
    .replace(/\s*([{}:;,>])\s*/g, "$1")        // around structural punctuation
    .replace(/;}/g, "}")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rewrite a source page's inline <style> from the canonical stylesheet.
 * Returns true when the file on disk actually changed, so the build can say so
 * and so a second run over unchanged stylesheets is a genuine no-op.
 */
function writeSourceStyle(srcPath, minifiedCss) {
  const original = readFileSync(srcPath, "utf8");
  const pattern = new RegExp(
    `(?:${escapeRegExp(GENERATED_CSS_NOTE)}\\s*)?<style>[\\s\\S]*?<\\/style>`,
  );
  if (!pattern.test(original)) {
    throw new Error(`cannot generate CSS: ${srcPath} has no <style> block to replace`);
  }
  const updated = original.replace(
    pattern,
    `${GENERATED_CSS_NOTE}\n<style>\n${minifiedCss}\n</style>`,
  );
  if (updated === original) return false;
  writeFileSync(srcPath, updated);
  return true;
}

/** Drop the generated block - marker included - from a dist document. */
function dropInlineStyle(html) {
  return html
    .replace(new RegExp(`\\s*${escapeRegExp(GENERATED_CSS_NOTE)}`), "")
    .replace(/\s*<style>[\s\S]*?<\/style>/, "");
}

/** Minify the bodies of inline <style>/<script> blocks; leave all markup alone. */
async function slimHtml(html) {
  // Any <style> still reaching here is a page styling itself (thank-you.html),
  // not a copy of the linked sheet, so it is minified but never dropped.
  let out = html.replace(/<style>([\s\S]*?)<\/style>/, (_all, css) => `<style>${minifyCss(css)}</style>`);

  // Only inline (no src) and non-JSON-LD scripts, whose body is plain JS. The
  // source keeps its section comments; dist does not need them.
  const bodies = [];
  out = out.replace(
    /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g,
    (all, body) => {
      if (!body.trim()) return all;
      bodies.push(body);
      return all.replace(body, `\u0001${bodies.length - 1}\u0001`);
    },
  );
  for (const [i, body] of bodies.entries()) {
    out = out.replace(`\u0001${i}\u0001`, await minifyInlineScript(body));
  }

  return { html: out };
}

/** esbuild-powered minification of an inline script body, for dist only. */
async function minifyInlineScript(body) {
  const result = await build({
    stdin: { contents: body, loader: "js", resolveDir: sharedDir },
    minify: true,
    target: ["es2019"],
    write: false,
  });
  return result.outputFiles[0].text.trim();
}

/**
 * Whitespace and comment removal for the markup itself. <pre> and <textarea>
 * are excluded because collapsing whitespace inside them changes what the
 * customer sees.
 */
function slimMarkup(html) {
  const protectedRegions = [];
  const stash = (match) => {
    protectedRegions.push(match);
    return `\u0000${protectedRegions.length - 1}\u0000`;
  };
  let out = html
    .replace(/<pre[\s\S]*?<\/pre>/g, stash)
    .replace(/<textarea[\s\S]*?<\/textarea>/g, stash)
    .replace(/<!--[\s\S]*?-->/g, "")           // section markers are for the source
    .replace(/\n\s*/g, "\n")
    .replace(/>\n+</g, "><")
    .replace(/[ \t]{2,}/g, " ");
  out = out.replace(/\u0000(\d+)\u0000/g, (_all, i) => protectedRegions[Number(i)]);
  return out;
}

/* ------------------------------------------------------------------
 * Caching headers for Cloudflare Pages.
 *
 * Assets are already content-hashed (site.<hash>.min.css), so they can be
 * cached for a year and never revalidated; the HTML documents must not be, or a
 * deploy would never reach anybody. Emitting this now makes turning caching on
 * later a config change rather than a refactor.
 * ------------------------------------------------------------------ */
function emitHeaders() {
  writeFileSync(join(distDir, "_headers"), `/*
 * Generated by build/bundle.mjs - do not edit by hand.
 */

/site.*
  Cache-Control: public, max-age=31536000, immutable

/*.html
  Cache-Control: public, max-age=0, must-revalidate

/sitemap.xml
  Cache-Control: public, max-age=3600

/robots.txt
  Cache-Control: public, max-age=3600
`);
}

/**
 * Copy an HTML source file to dist, injecting the icon sprite and rewriting
 * bundle placeholders.
 *
 * `cssMode` is what the page does with its stylesheet:
 *   "drop"   - its styles ARE the linked sheet, so the document must not carry
 *              a second copy of the bytes the <link> is already fetching.
 *   "minify" - it styles itself inline, so the block is kept and collapsed.
 */
async function emitHtml(srcPath, replacements, cssMode) {
  let html = readFileSync(srcPath, "utf8");
  const sprite = readFileSync(join(sharedDir, "icons", "sprite.svg"), "utf8");
  html = html.replace("<!-- ICONS -->", sprite);
  for (const [placeholder, value] of Object.entries(replacements)) {
    html = html.replaceAll(placeholder, value);
  }
  // Build-time configuration, injected into the page itself. The source file
  // is left exactly as authored — it is the dist copy that carries the values
  // for whichever environment this build targets.
  html = html.replace("</head>", `${runtimeConfigScript()}</head>`);
  if (cssMode === "drop") html = dropInlineStyle(html);

  const before = Buffer.byteLength(html);
  const { html: slimmed } = await slimHtml(html);
  const final = slimMarkup(slimmed);
  const rel = relative(siteRoot, srcPath);
  const outPath = join(distDir, rel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, final);

  return { rel, before, after: Buffer.byteLength(final), cssMode };
}

/** Copies a file into dist, applying the same placeholder replacements as HTML. */
function copyStaticFile(name, replacements = {}) {
  const src = join(siteRoot, name);
  if (!existsSync(src)) return;
  // robots.txt and sitemap.xml are full of absolute URLs, so they are rewritten
  // as text; anything else is copied byte-for-byte.
  const target = join(distDir, name);
  if (/\.(txt|xml|json)$/.test(name)) {
    let content = readFileSync(src, "utf8");
    for (const [placeholder, value] of Object.entries(replacements)) {
      content = content.replaceAll(placeholder, value);
    }
    writeFileSync(target, content);
    return;
  }
  copyFileSync(src, target);
}

async function main() {
  cleanDist();

  // Customer-facing bundle. Order matters and is enforced by the import graph
  // in orchestrate.js (apiClient -> render/validate -> orchestrate), not by
  // this list — this list only says which file is the entry point.
  const siteCss = await bundleCss(SITE_STYLES, "site");
  const siteJs = await bundleJs("orchestrate.js", "site");

  // Admin bundle — never shipped to a customer-facing page.
  const adminCss = await bundleCss(ADMIN_STYLES, "admin");
  const adminJs = await bundleJs("admin.js", "admin");

  const replacements = {
    "__SITE_CSS__": siteCss.filename,
    "__SITE_JS__": siteJs,
    "__ADMIN_CSS__": adminCss.filename,
    "__ADMIN_JS__": adminJs,
    // Environment values. The source keeps these placeholders; the dist copy
    // carries the values for the environment being built.
    "YOUR_TURNSTILE_SITE_KEY": config.turnstileSiteKey,
    "https://yoursite.com": config.siteUrl,
    "https://picsum.photos": config.placeholderImageBase,
    // The version marker the admin's deployment check reads back off the live page.
    // Empty stays empty; it is not dropped, because a page missing the tag would
    // be indistinguishable from one built before versioning existed.
    "__STOREFRONT_PUBLISH_ID__": config.storefrontPublishId,
  };
  // Every product page + thank-you.html gets the customer bundle + sprite.
  const customerHtml = [];
  const productHtmlFiles = existsSync(join(siteRoot, "products"))
    ? walkHtmlFiles(join(siteRoot, "products"))
    : [];
  for (const file of productHtmlFiles) {
    // The page's inline copy is GENERATED from the same bytes as the hashed
    // sheet, so the file:// preview and the served page cannot disagree. This
    // is the one place the build writes back into the source tree, and it is a
    // no-op the moment shared/styles is unchanged.
    if (writeSourceStyle(file, siteCss.minified)) {
      console.log(`  regenerated inline <style>  ${relative(siteRoot, file)}`);
    }
    customerHtml.push(await emitHtml(file, replacements, "drop"));
  }

  // thank-you.html styles itself; it keeps its own (much smaller) inline CSS.
  const thankYouPath = join(siteRoot, "thank-you.html");
  if (existsSync(thankYouPath)) customerHtml.push(await emitHtml(thankYouPath, replacements, "minify"));

  // Admin gets its own bundle + sprite, never the customer JS bundle. Its
  // stylesheet is not the one the page links, so nothing is stripped from it.
  const adminPath = join(siteRoot, "admin", "index.html");
  if (existsSync(adminPath)) await emitHtml(adminPath, replacements, "minify");

  copyStaticFile("sitemap.xml", replacements);
  copyStaticFile("robots.txt", replacements);

  // admin-auth v2 UI is served from the backend source (src/auth-ui) behind the
  // server-side admin guard (/admin/sign-in/, /admin/assets/*). It is NOT
  // copied to dist (no /auth-ui/ route) — see currentwork.md step C.

  emitHeaders();

  console.log("Build complete:");
  console.log(`  ${siteCss.filename}`);
  console.log(`  ${siteJs}`);
  console.log(`  ${adminCss.filename}`);
  console.log(`  ${adminJs}`);
  console.log(`  _headers (hashed assets cached 1y, HTML revalidated)`);
  console.log(`  env: ${loadedEnvFile ? "repository .env" : "process environment only"}`
    + ` | site ${config.siteUrl}`
    + ` | api ${config.apiBase || "(same origin)"}`
    + ` | media ${config.imageDeliveryBase}`
    + ` | turnstile ${config.turnstileSiteKey ? "configured" : "disabled (no site key)"}`);
  for (const page of customerHtml) {
    const css = page.cssMode === "drop" ? "CSS from the linked sheet only" : "own inline CSS, minified";
    console.log(`  ${page.rel}: ${page.before} -> ${page.after} bytes (-${page.before - page.after}, ${css})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
