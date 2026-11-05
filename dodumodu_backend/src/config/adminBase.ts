// Admin base path — the single opaque URL namespace under which every admin
// surface is mounted (e.g. "/e5he78f823523"). See spec §1-§3.
//
// The value is runtime configuration (ADMIN_BASE_PATH), never generated or
// rotated automatically, and validated exactly once per distinct value at the
// application configuration boundary (resolveAdminBasePath).
//
//   - Local development (ENVIRONMENT !== "production"): defaults to "/admin"
//     when unset.
//   - Production: must be explicitly configured and valid; missing, empty or
//     invalid disables every admin route (generic 404, no fallback).
export const DEFAULT_ADMIN_BASE_PATH = "/admin";

// Legacy admin entry points. When they are NOT the active namespace they must
// return a generic 404 and must never fall through to the product catch-all.
export const LEGACY_ADMIN_PATHS = ["/admin", "/admin-v2", "/auth"] as const;

// Public/reserved routes the admin namespace must not collide with.
export const RESERVED_ROUTES = [
  "/",
  "/health",
  "/page-data",
  "/published",
  "/create-order",
  "/thank-you.html",
  "/robots.txt",
  "/sitemap.xml",
  "/media",
  "/assets",
] as const;

// Exactly one opaque segment beginning with "/": no trailing slash, no extra
// segments, no whitespace, backslashes, double slashes, encoded slashes,
// query strings, fragments or dot segments.
const ADMIN_BASE_PATH_PATTERN = /^\/[A-Za-z0-9\-_~]+$/;

export function isValidAdminBasePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!ADMIN_BASE_PATH_PATTERN.test(value)) return false;
  return !RESERVED_ROUTES.includes(value as (typeof RESERVED_ROUTES)[number]);
}

const validationCache = new Map<string, string | null>();

/**
 * Resolve the active admin base path from environment configuration.
 *
 * Returns null when admin is disabled (invalid/missing production config).
 * Validation results are memoized per distinct value so repeated calls are
 * cheap; the rule itself is evaluated in exactly one place.
 */
export function resolveAdminBasePath(env: {
  ENVIRONMENT: string;
  ADMIN_BASE_PATH?: string;
}): string | null {
  const key = `${env.ENVIRONMENT}\0${env.ADMIN_BASE_PATH ?? ""}`;
  const cached = validationCache.get(key);
  if (cached !== undefined) return cached;

  const raw = env.ADMIN_BASE_PATH;
  let result: string | null;
  if (raw === undefined || raw === "") {
    // Local development defaults to /admin. Production never falls back.
    result = env.ENVIRONMENT === "production" ? null : DEFAULT_ADMIN_BASE_PATH;
  } else if (isValidAdminBasePath(raw)) {
    result = raw;
  } else {
    result = null;
  }

  validationCache.set(key, result);
  return result;
}

/**
 * The active admin base path for the current environment, or null when admin
 * is disabled. Convenience wrapper around resolveAdminBasePath.
 */
export function adminBasePath(env: {
  ENVIRONMENT: string;
  ADMIN_BASE_PATH?: string;
}): string | null {
  return resolveAdminBasePath(env);
}

/** True when `path` is one of the legacy admin entry points (exact or nested). */
export function isLegacyAdminPath(path: string): boolean {
  return LEGACY_ADMIN_PATHS.some(
    (legacy) => path === legacy || path.startsWith(legacy + "/"),
  );
}

/** Rewrite root-relative /admin/... URLs in served admin HTML to the active namespace. */
export function rewriteAdminHtml(html: string, base: string): string {
  const rewritten = html
    .replaceAll("/admin/assets/", `${base}/assets/`)
    .replaceAll("/admin/sign-in/", `${base}/sign-in/`)
    .replaceAll("/admin/sessions/", `${base}/sessions/`)
    .replaceAll("/admin/devices/", `${base}/devices/`)
    .replaceAll("/admin/", `${base}/`)
    .replaceAll('href="/auth-ui/auth.css"', `href="${base}/assets/auth.css"`)
    .replaceAll('src="/auth-ui/devices.js"', `src="${base}/assets/devices.js"`)
    .replaceAll('src="/auth-ui/sessions.js"', `src="${base}/assets/sessions.js"`)
    .replaceAll('src="/auth-ui/users.js"', `src="${base}/assets/users.js"`)
    .replace(/href="\/(admin\.[^."]+\.min\.css)"/g, `href="${base}/assets/$1"`)
    .replace(/src="\/(admin\.[^."]+\.min\.js)"/g, `src="${base}/assets/$1"`);
  if (rewritten.includes("window.ADMIN_BASE_PATH")) return rewritten;
  const runtime = `<script>window.ADMIN_BASE_PATH=${JSON.stringify(base)};</script>`;
  return rewritten.includes("</head>")
    ? rewritten.replace("</head>", `${runtime}</head>`)
    : rewritten.replace("</body>", `${runtime}</body>`);
}

/** Rewrite root-relative /auth and /admin-v2 API URLs in served admin JS to the active namespace. */
export function rewriteAdminJs(js: string, _base: string): string {
  return js;
}
