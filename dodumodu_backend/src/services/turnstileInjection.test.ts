import { test } from "node:test";
import assert from "node:assert/strict";
import { injectTurnstile } from "./turnstileInjection";

const csp = "default-src &#39;none&#39;; script-src &#39;self&#39; &#39;sha256-x&#39;; img-src &#39;self&#39;; connect-src &#39;self&#39;; base-uri &#39;none&#39;; frame-ancestors &#39;none&#39;";
const page = `<meta http-equiv="Content-Security-Policy" content="${csp}"><div class="cf-turnstile" id="cf-turnstile" data-sitekey="" data-callback="onTurnstileToken"></div>`;

test("a page built without a site key gets the widget and a CSP that lets it load", () => {
  const { html, injected } = injectTurnstile(page, "0x4AAAAAAAabcdef");
  assert.ok(injected);
  assert.ok(html.includes('data-sitekey="0x4AAAAAAAabcdef"'));
  assert.match(html, /script-src https:\/\/challenges\.cloudflare\.com &#39;self&#39;/);
  assert.match(html, /frame-src https:\/\/challenges\.cloudflare\.com; base-uri/);
  // Regression: the page's CSP is HTML-escaped (&#39; contains a ';'). An edit to connect-src that split on ';' cut the quote
  // in half and left the page unable to POST /create-order. connect-src must come out byte-for-byte unchanged.
  assert.ok(html.includes("connect-src &#39;self&#39;; frame-src"));
});

test("a page that already has a key, or no key configured, or a malformed key, is left exactly as it is", () => {
  const keyed = page.replace('data-sitekey=""', 'data-sitekey="0xREAL1234"');
  assert.equal(injectTurnstile(keyed, "0x4AAAAAAAabcdef").html, keyed);
  assert.equal(injectTurnstile(page, undefined).html, page);
  assert.equal(injectTurnstile(page, "").injected, false);
  assert.equal(injectTurnstile(page, '"><script>x</script>').injected, false);
});

test("a product with the bot check off has any baked-in site key removed, so the page asks for no challenge", async () => {
  const { stripTurnstile } = await import("./turnstileInjection");
  const baked = '<div id="cf-turnstile" data-sitekey="0x4AAAAAAAbaked"></div>';
  const out = stripTurnstile(baked);
  assert.equal(out.stripped, true);
  assert.equal(out.html, '<div id="cf-turnstile" data-sitekey=""></div>');
  // Nothing baked: nothing to strip, and the page is returned untouched.
  const bare = stripTurnstile('<div id="cf-turnstile" data-sitekey=""></div>');
  assert.equal(bare.stripped, false);
});
