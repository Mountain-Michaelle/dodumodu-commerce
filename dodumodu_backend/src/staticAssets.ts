// Storefront static assets served directly by the Worker in production.
// Production has no Cloudflare Pages/static middleware, so the Worker must
// serve the customer JS bundle, thank-you page, robots.txt, sitemap.xml, and
// media. These are inlined here rather than read from disk at request time.

/**
 * Order confirmation page source, with the build-time `__SITE_CSS__`
 * placeholder removed. The page carries its own inline <style> block and
 * inline SVG sprite, so it renders correctly without the shared stylesheet
 * link. The build injects `window.API_BASE` / `window.IMAGE_DELIVERY_BASE`
 * defaults that match this source.
 */
export const THANK_YOU_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Order received</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#fff8f5">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-112 0 480 480'%3E%3Cpath fill='%23F7A21B' fill-rule='evenodd' d='M0 208H194a8 8 0 0 1 8 8V406a8 8 0 0 1-8 8H34a8 8 0 0 1-7.9-6.6L-7.9 217.4A8 8 0 0 1 0 208zM14 273.5h156a4.5 4.5 0 0 1 0 9H14a4.5 4.5 0 0 1 0-9zM30 337.5h140a4.5 4.5 0 0 1 0 9H30a4.5 4.5 0 0 1 0-9zM57.5 273.5V240a4.5 4.5 0 0 1 9 0v33.5zM57.5 282.5h9v55h-9zM57.5 346.5h9V382a4.5 4.5 0 0 1-9 0zM113.5 273.5V240a4.5 4.5 0 0 1 9 0v33.5zM113.5 282.5h9v55h-9zM113.5 346.5h9V382a4.5 4.5 0 0 1-9 0z'/%3E%3Cpath d='M218 382V30h22' fill='none' stroke='%23F7A21B' stroke-width='48' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath fill='%231F2A44' fill-rule='evenodd' d='M23 441a32 32 0 1 0 64 0a32 32 0 1 0-64 0M43 441a12 12 0 1 0 24 0a12 12 0 1 0-24 0zM123 441a32 32 0 1 0 64 0a32 32 0 1 0-64 0M143 441a12 12 0 1 0 24 0a12 12 0 1 0-24 0z'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/__SITE_CSS__">
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#fff8f5;color:#2b2320}
  /* Top padding is smaller than before (56px -> 28px): the brand header above now
     provides the breathing room, and the confirmation stays on the first screen. */
  .confirm-page{max-width:480px;margin:0 auto;padding:28px 20px 72px;text-align:center}
  .confirm-icon{width:56px;height:56px;color:#2f7d4f;margin:0 auto 16px}
  .confirm-status{font-size:0.9rem;color:#6b5f59;margin-top:10px}
  .order-summary{text-align:left;margin-top:24px}
  /* The reference is a code, not a price. Monospaced and lowercase so it is read
     one character at a time when it is read back to us over the phone, and so a
     letter O can never be taken for a zero. The value is lowercased in markup
     too, because orders placed before this format are still uppercase in the
     database and must look the same to the customer. */
  .confirm-reference{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.92em;letter-spacing:0.02em;overflow-wrap:anywhere}
  .confirm-next{margin-top:28px;padding:20px 22px;border:1px solid #f0e2dc;border-radius:16px;background:#fff;text-align:left}
  .confirm-next h2{margin:0 0 12px;font-size:0.78rem;letter-spacing:0.08em;text-transform:uppercase;color:#8a7b74}
  .confirm-next ul{margin:0;padding-left:20px;font-size:0.95rem;line-height:1.6;color:#4a3f3a}
  .confirm-next li+li{margin-top:10px}
  .confirm-actions{margin-top:32px;display:flex;flex-direction:column;align-items:center;gap:12px}
  .back-link{display:inline-flex;align-items:center;gap:9px;padding:14px 28px;border-radius:999px;background:#2f7d4f;color:#fff;font-size:1rem;font-weight:600;text-decoration:none;box-shadow:0 6px 18px rgba(47,125,79,.24)}
  .back-link:hover{background:#27693f}
  .back-link:focus-visible{outline:3px solid #1d4d2f;outline-offset:3px}
  .back-hint{margin:0;font-size:0.85rem;color:#8a7b74}
  .pay-link{color:#2f7d4f;font-weight:600}

  /* ---------------------------------------------------------------------
     BRAND - DODUMODU logo. Inline SVG sprite (see <body>): no request, paints
     with the HTML, navy follows CSS \`color\`. pointer-events:none leaves no
     Save-image / drag target on the artwork.
     --------------------------------------------------------------------- */
      
  /* ---------------------------------------------------------------------
     THANK-YOU LOGO (§2a): arrival animation runs once (~2 s), then settles.
     Pixel-identical to the static logo at rest (0 px differ).
     --------------------------------------------------------------------- */
  .confirm-page{padding-top:28px}
  .brand-bar{display:flex;justify-content:center;padding:0 0 24px;margin:0 0 28px;border-bottom:1px solid #f0e2dc;line-height:0}
  .dm-hero{width:clamp(200px,62vw,300px)}
  .confirm-sign{margin:40px 0 0;display:flex;flex-direction:column;align-items:center;gap:10px;font-size:.8rem;color:#8a7b74;line-height:1.2}
  .dm-sign{width:112px;opacity:.92}
  .dm-once .dm-b{animation-iteration-count:4}
  .dm-once .dm-r{animation-iteration-count:2}
  .dm-once .dm-s path{animation:dm-g .8s ease-out}
  .dm-once.dm-run .dm-s g path{animation-delay:0s}
  @keyframes dm-g{from{transform:scaleX(.1);opacity:0}}

  /* Bottom: a sign-off, deliberately NOT a link, so the green "Back to the
     store" button stays the single clear next action. */
  .confirm-signoff{margin-top:44px;padding-top:26px;border-top:1px solid #f0e2dc;display:flex;flex-direction:column;align-items:center;gap:12px}
  .confirm-signoff-text{margin:0;font-size:0.8rem;letter-spacing:0.02em;color:#8a7b74}

  /* A single, gentle pop on the success tick. Skipped for anyone who has asked
     their device to reduce motion. The logo itself is never animated, so it
     paints immediately and never delays the first meaningful paint. */
  @media (prefers-reduced-motion:no-preference){
    .confirm-icon{animation:confirm-pop .45s cubic-bezier(.2,.9,.3,1.2) both}
    @keyframes confirm-pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
  }
  @media (min-width:768px){
    .confirm-page{padding-top:36px}
  }
</style>
<script>window.API_BASE="";window.IMAGE_DELIVERY_BASE="/media";</script></head>
<body>

<!-- =====================================================================
     BRAND SPRITE - the DODUMODU logo, defined once, used by <use href="#dm-logo">.
     Zero-size (NOT display:none, which breaks <use> references in Safari).
     Colours: navy = currentColor (set via CSS \`color\`), orange = #F7A21B.
     Identical to the sprite on the product page.
     ===================================================================== -->
<svg class="dm-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs><linearGradient id="dm-f" gradientUnits="userSpaceOnUse" x2="450"><stop stop-color="#F7A21B" stop-opacity=".6"/><stop offset="1" stop-color="#F7A21B" stop-opacity="0"/></linearGradient><path id="dm-w" fill="currentColor" fill-rule="evenodd" d="M-32 0a32 32 0 1 0 64 0a32 32 0 1 0-64 0M-12 0a12 12 0 1 0 24 0a12 12 0 1 0-24 0z"/><g id="dm-d"><path fill="#F7A21B" fill-rule="evenodd" d="M23.5 208H221.5a6 6 0 0 1 6 6V408a6 6 0 0 1-6 6H58.5a6 6 0 0 1-5.9-4.9L17.6 215.1A6 6 0 0 1 23.5 208zM40 273.5h155.5a4.5 4.5 0 0 1 0 9H40a4.5 4.5 0 0 1 0-9zM56 337.5h139.5a4.5 4.5 0 0 1 0 9H56a4.5 4.5 0 0 1 0-9zM83.5 273.5V240a4.5 4.5 0 0 1 9 0v33.5zM83.5 282.5h9v55h-9zM83.5 346.5h9V381.5a4.5 4.5 0 0 1-9 0zM139.5 273.5V240a4.5 4.5 0 0 1 9 0v33.5zM139.5 282.5h9v55h-9zM139.5 346.5h9V381.5a4.5 4.5 0 0 1-9 0z"/><path d="M244 382V30h21.5" fill="none" stroke="#F7A21B" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/><use href="#dm-w" x="81" y="441"/><use href="#dm-w" x="181" y="441"/></g><g id="dm-o"><g fill="none" stroke="currentColor"><circle r="112" stroke-width="36"/><path d="M0-98V98M-85-49L85 49M-85 49L85-49" stroke-width="9"/></g><circle r="26" fill="#F7A21B"/><circle r="10" fill="currentColor"/></g><g id="dm-b"><use href="#dm-d"/><use href="#dm-d" x="596"/><path d="M946 240v118a24 24 0 0 0 24 24h142a24 24 0 0 0 24-24V240M1220 382V305a65 65 0 0 1 130 0V382M1350 305a65 65 0 0 1 130 0V382" fill="none" stroke="currentColor" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/><use href="#dm-w" x="984" y="441"/><use href="#dm-w" x="1098" y="441"/><use href="#dm-w" x="1220" y="441"/><use href="#dm-w" x="1350" y="441"/><use href="#dm-w" x="1480" y="441"/></g><g id="dm-c"><use href="#dm-b"/><use href="#dm-o" x="456" y="346"/><use href="#dm-o" x="1670" y="346"/></g><g id="dm-s" fill="none" stroke="url(#dm-f)" stroke-width="14" stroke-linecap="round"><path transform="translate(1709 199)" d="M0 0h248"/><path transform="translate(1796 261)" d="M0 0h125"/><path transform="translate(1820 323)" d="M0 0h203"/><path transform="translate(1817 385)" d="M0 0h158"/><path transform="translate(1784 447)" d="M0 0h86"/></g><g id="dm-logo"><use href="#dm-c"/><use href="#dm-s"/></g></defs></svg>

<!-- ICONS -->

<main class="confirm-page">
  <a class="brand-bar" href="/" aria-label="DODUMODU home"><svg class="dm dm-hero dm-run dm-once" viewBox="1 -16 2030 504" width="240" height="60" aria-hidden="true" focusable="false"><g transform="translate(750 441)"><g class="dm-b"><use href="#dm-b" x="-750" y="-441"/></g></g><g transform="translate(456 346)"><use class="dm-r" href="#dm-o"/></g><g transform="translate(1670 346)"><use class="dm-r" href="#dm-o"/></g><g class="dm-s" fill="none" stroke="url(#dm-f)" stroke-width="14" stroke-linecap="round"><g transform="translate(1709 199)"><path d="M0 0h248"/></g><g transform="translate(1796 261)"><path d="M0 0h125"/></g><g transform="translate(1820 323)"><path d="M0 0h203"/></g><g transform="translate(1817 385)"><path d="M0 0h158"/></g><g transform="translate(1784 447)"><path d="M0 0h86"/></g></g></svg></a>
  <svg class="confirm-icon" aria-hidden="true"><use href="#icon-check"></use></svg>
  <h1>We've received your order</h1>
  <p id="confirm-message">Hang tight while we confirm the details.</p>
  <p class="confirm-status" id="confirm-status"></p>
  <div id="order-summary" class="order-summary price-breakdown"></div>

  <section class="confirm-next">
    <h2>What happens next</h2>
    <ul>
      <li>Someone from our team will call or WhatsApp you on the number you gave us, to confirm your address and agree a delivery time.</li>
      <li id="next-payment">Please keep your reference handy, and quote it if you get in touch about this order.</li>
      <li>Nothing is dispatched until your order is confirmed, so there is no need to do anything else right now.</li>
    </ul>
  </section>

  <div class="confirm-actions">
    <a class="back-link" href="/products/glow-serum/">&larr; Back to the store</a>
    <p class="back-hint">Ordering again? Your form comes back empty and ready.</p>
  </div>

  <footer class="confirm-signoff">
    <p class="confirm-sign">
      <span>Thank you for shopping with</span>
      <svg class="dm dm-sign" viewBox="1 -16 2030 504" width="112" height="28" role="img" aria-label="DODUMODU" focusable="false"><use href="#dm-logo"/></svg>
    </p>
  </footer>
</main>

<script>
  // Never claim payment succeeded just because the customer landed here (§6 step 8, §8.3).
  // Payment status only ever changes via the verified webhook or reconciliation job.
  //
  // The summary below is rendered straight from the create-order response
  // stored by orchestrate.js — never recomputed in the browser (§6 step 9),
  // so it always exactly matches what was actually charged.
  (function () {
    function formatNaira(kobo) {
      return "\u20A6" + Math.round(kobo / 100).toLocaleString("en-NG");
    }

    // Values below are interpolated into markup, so they are escaped even though
    // they come from our own API: sessionStorage is script-readable storage, and
    // a stray value should never be able to turn into markup.
    function esc(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    var raw = sessionStorage.getItem("skincare_last_order");
    var messageEl = document.getElementById("confirm-message");
    var statusEl = document.getElementById("confirm-status");
    var summaryEl = document.getElementById("order-summary");
    var paymentNoteEl = document.getElementById("next-payment");
    if (!raw) return;

    var order = JSON.parse(raw);

    // Each branch says what actually happens next, and roughly how long it takes.
    // A bare "we received it" leaves the customer unsure whether the order went
    // through, what they are waiting for, and whether they owe anything else.
    if (order.status === "confirmed_cod") {
      messageEl.textContent = "Your pay-on-delivery order is in. There is nothing more to pay online \u2014 our rider settles with you when your order arrives.";
      statusEl.textContent = "We will call you shortly to agree a delivery time.";
      paymentNoteEl.textContent = "Nothing more to pay online: you pay the rider in cash on delivery.";
    } else if (order.checkoutUrl) {
      messageEl.textContent = "One more step — complete your payment to finish the order.";
      statusEl.innerHTML = '<a class="pay-link" href="' + esc(order.checkoutUrl) + '">Continue to payment</a>';
      paymentNoteEl.textContent = "Pay online to secure your order, or message us if you would rather sort it out another way.";
    } else {
      messageEl.textContent = "Your order is saved. We are confirming the payment now \u2014 this normally takes under a minute.";
      paymentNoteEl.textContent = "We will message you on the number you gave us as soon as the payment is confirmed.";
    }

    if (typeof order.quantity === "number") {
      var rows = [
        // Lowercased here as well as in CSS. References written before this
        // format are still uppercase in the database, and the customer should not
        // be able to tell which era their order came from.
        '<div class="price-breakdown-row"><span>Reference</span><span class="confirm-reference">' + esc(String(order.reference || "").toLowerCase()) + "</span></div>",
        '<div class="price-breakdown-row"><span>Unit price</span><span>' + formatNaira(order.unitPrice) + "</span></div>",
        '<div class="price-breakdown-row"><span>Quantity</span><span>' + esc(order.quantity) + "</span></div>",
        '<div class="price-breakdown-row"><span>Subtotal</span><span>' + formatNaira(order.subtotal) + "</span></div>",
      ];
      if (order.discountPercent > 0) {
        rows.push(
          '<div class="price-breakdown-row price-breakdown-discount"><span>Discount (' + esc(order.discountPercent) +
          '%)</span><span>\u2212' + formatNaira(order.discountAmount) + "</span></div>"
        );
      }
      rows.push('<div class="price-breakdown-row" data-emphasis="true"><span>Total</span><span>' + formatNaira(order.amount) + "</span></div>");
      summaryEl.innerHTML = rows.join("");
    }
  })();
</script>
</body>
</html>`;

export function robotsTxt(siteUrl: string): string {
  const base = siteUrl ? siteUrl.replace(/\/+$/, "") : "";
  const lines = [
    "User-agent: *",
    "Allow: /products/",
    "Disallow: /admin/",
    "Disallow: /thank-you.html",
    "",
  ];
  if (base) lines.push(`Sitemap: ${base}/sitemap.xml`);
  return lines.join("\n") + "\n";
}

export function sitemapXml(siteUrl: string, products: Record<string, unknown>): string {
  const base = siteUrl ? siteUrl.replace(/\/+$/, "") : "";
  const urls = [
    `  <url><loc>${base === "" ? "/" : base + "/"}</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
  ];
  for (const slug of Object.keys(products)) {
    const loc = base === "" ? `/${slug}/` : `${base}/${slug}/`;
    urls.push(`  <url><loc>${loc}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
}
