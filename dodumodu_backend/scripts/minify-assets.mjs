// Everything the admin serves to a browser is minified and stripped of comments at build time, so the network tab shows
// compact code rather than readable source with developer notes, file banners and template placeholders.
//
// Honest limit: minified code is harder to READ, not secret. What protects the admin is that the server checks every
// request (session, role, step-up) and that no secret is ever put in a client file - scripts/check-assets.mjs enforces
// the second part on the final output.
import { transformSync } from "esbuild";

export function minifyJs(code, { module = false } = {}) {
  return transformSync(code, { loader: "js", minify: true, legalComments: "none", charset: "utf8", ...(module ? { format: "esm" } : {}) }).code;
}
export function minifyCss(code) {
  return transformSync(code, { loader: "css", minify: true, legalComments: "none", charset: "utf8" }).code;
}
/** Removes HTML comments only; markup, inline scripts and whitespace that matters are left exactly as written. */
export function stripHtmlComments(html) {
  return html.replace(/<!--(?!\[if)[\s\S]*?-->/g, "");
}
