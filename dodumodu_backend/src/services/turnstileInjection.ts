/**
 * The bot-check widget must be on every storefront page that can take an order, whichever build produced the page.
 *
 * The server refuses an order that carries no Turnstile token (when TURNSTILE_SECRET_KEY is set). The page only asks for
 * a token if it was built with TURNSTILE_SITE_KEY, and its CSP only allows Cloudflare's challenge origin in that case.
 * A page from a build that did not have the key (a Cloudflare git build, a missing repository Variable) therefore
 * rejected every customer. The site key is public, so the Worker supplies it at request time instead: it is set once as
 * a Worker variable and applies to every page, baked or rendered from the database.
 */
const CHALLENGES = "https://challenges.cloudflare.com";
const EMPTY_WIDGET = 'id="cf-turnstile" data-sitekey=""';

export function injectTurnstile(html: string, siteKey: string | undefined): { html: string; injected: boolean } {
  const key = (siteKey ?? "").trim();
  // Turnstile keys are short alphanumeric strings; anything else is a misconfiguration, never markup.
  if (!/^[0-9A-Za-z_-]{6,80}$/.test(key) || !html.includes(EMPTY_WIDGET)) return { html, injected: false };

  let out = html.replace(EMPTY_WIDGET, `id="cf-turnstile" data-sitekey="${key}"`);
  out = out.replace(/(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/, (_m, open: string, csp: string, close: string) => {
    let next = csp;
    if (!next.includes(CHALLENGES)) {
      next = next.replace("script-src ", `script-src ${CHALLENGES} `);
      next = /frame-src /.test(next)
        ? next.replace("frame-src ", `frame-src ${CHALLENGES} `)
        : next.replace("; base-uri", `; frame-src ${CHALLENGES}; base-uri`);
    }
    // Cloudflare's widget page also talks to its own origin; allow it so a strict connect-src never starves the challenge.
    next = next.replace(/connect-src ([^;]*)/, (m, v: string) => (v.includes(CHALLENGES) ? m : `connect-src ${v} ${CHALLENGES}`));
    return open + next + close;
  });
  return { html: out, injected: true };
}
