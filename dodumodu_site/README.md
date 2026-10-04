# dodumodu-site

The storefront: hand-written HTML, CSS and ES modules, bundled and minified by
`build/bundle.mjs` into `dist/`. No framework, no runtime dependencies — the
whole customer bundle is about 6 KB gzipped.

```bash
npm run build     # -> dist/ (with build-time values injected)
npm test          # form UX + size budget + pricing smoke
```

The source files (`products/`, `admin/`, `thank-you.html`) are **identical in
every environment**. Nothing environment-specific is committed: canonical URLs,
the Turnstile site key and the placeholder image host are placeholders in the
source, and the build replaces them with the values below. What lands in `dist/`
differs per environment; the source never does.

## Build-time configuration

Read from the repository-root `.env`, or from real environment variables
(Cloudflare Pages sets these as project environment variables — there is no
`.env` in a Pages build, and real variables always win).

| Variable | Effect on `dist/` |
| --- | --- |
| `SITE_URL` | `<link rel=canonical>`, `og:url`, JSON-LD ids, sitemap.xml, robots.txt |
| `API_BASE` | injected as `window.API_BASE`; **empty = same origin** |
| `IMAGE_DELIVERY_BASE` | injected as `window.IMAGE_DELIVERY_BASE` (`/media` locally) |
| `TURNSTILE_SITE_KEY` | `data-sitekey`; empty disables the widget (local only) |
| `PLACEHOLDER_IMAGE_BASE` | hero/testimonial placeholder imagery |

The two injected values are public by definition — they are already visible in
the HTML and in the requests. No secret is ever written into a page or a bundle.

## What the source guarantees

- The order form's logic, pricing display and validation live in
  `shared/scripts/`; the page's own inline script is a progressive-enhancement
  fallback for a browser that never receives the bundle.
- The storefront never decides a price, a discount or a payment rule. It renders
  what `/page-data/:slug` publishes and re-checks nothing — the server is the
  authority, and the two are kept from drifting by `test/form-ux.check.mjs`.
- Turnstile is never in the critical path: it is armed near the form, on focus,
  or at submit, and skipped entirely when no site key is configured.
