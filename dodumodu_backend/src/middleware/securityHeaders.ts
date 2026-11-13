// Browser-side protections on every response this Worker sends. Set only when a route has not already chosen a value,
// so a route that needs something different stays in control; nothing here changes a body or a status.
//
//   X-Content-Type-Options  : a script is never guessed from a file that was served as something else
//   X-Frame-Options / frame-ancestors : the admin and the API cannot be framed (click-jacking)
//   Strict-Transport-Security : production only - browsers refuse to talk to this host over plain http
//   Referrer-Policy / Permissions-Policy : no addresses leak outward, no camera/mic/geolocation/payment prompts
//   Content-Security-Policy :
//       HTML pages  - scripts and styles only from this origin plus the exact inline blocks the page itself carries
//                     (hashed per response, so there is no blanket 'unsafe-inline' for scripts), nothing else loads,
//                     no <base>, forms only post back here
//       other bodies - default-src 'none'
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { isNonProduction } from "../config/environment";

const inlineHashes = new Map<string, string>();

async function sha256b64(text: string): Promise<string> {
  const cached = inlineHashes.get(text);
  if (cached) return cached;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let bin = ""; for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  const out = `'sha256-${btoa(bin)}'`;
  if (inlineHashes.size > 200) inlineHashes.clear();
  inlineHashes.set(text, out);
  return out;
}

/** The origin product images are served from when that is a separate host (IMAGE_DELIVERY_BASE = "https://media..."), else none. */
export function mediaOrigin(base: string | undefined): string {
  try { return base && /^https:\/\//i.test(base) ? new URL(base).origin : ""; } catch { return ""; }
}

/** The CSP for an HTML document, derived from the inline <script>/<style> blocks it actually contains. */
export async function htmlCsp(html: string, imageOrigin = ""): Promise<string> {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) if (m[1].trim()) scripts.push(await sha256b64(m[1]));
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) if (m[1].trim()) styles.push(await sha256b64(m[1]));
  return [
    "default-src 'none'",
    `script-src 'self' ${scripts.join(" ")}`.trim(),
    `style-src 'self' ${styles.join(" ")}`.trim(),
    // Style ATTRIBUTES (element.setAttribute("style", …)) are used by the console's own widgets; scripts stay locked.
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: ${imageOrigin}`.trim(),
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

export function securityHeaders(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    await next();
    // The CSP for an HTML page depends on its body, so that is settled first. Reading the body consumes it, so the
    // response is rebuilt from the text (status and every header carried over) before any header is added.
    if (!c.res.headers.has("Content-Security-Policy") && /text\/html/i.test(c.res.headers.get("content-type") ?? "")) {
      const original = c.res;
      try {
        const html = await original.text();
        const headers = new Headers(original.headers);
        // A page that declares its own policy (the storefront: scripts/build-site.mjs writes a <meta http-equiv> CSP that
        // already knows this deployment's media/Turnstile origins) keeps it. A second, fixed same-origin header here
        // would be ANDed with it and could block exactly those origins.
        if (!/<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy/i.test(html)) headers.set("Content-Security-Policy", await htmlCsp(html, mediaOrigin(c.env?.IMAGE_DELIVERY_BASE)));
        c.res = new Response(html, { status: original.status, statusText: original.statusText, headers });
      } catch {
        c.res = new Response(null, { status: 500 });                  // unreachable in practice; never serve a half-read page
      }
    }
    const res = c.res;
    const set = (name: string, value: string) => { if (!res.headers.has(name)) c.header(name, value); };
    set("X-Content-Type-Options", "nosniff");
    set("X-Frame-Options", "DENY");
    set("Referrer-Policy", "strict-origin-when-cross-origin");
    set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    set("Cross-Origin-Opener-Policy", "same-origin");
    if (!isNonProduction(c.env?.ENVIRONMENT)) set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    const isHtml = /text\/html/i.test(res.headers.get("content-type") ?? "");
    if (!res.headers.has("Content-Security-Policy") && res.status !== 101 && !isHtml) {
      c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    }
  };
}
