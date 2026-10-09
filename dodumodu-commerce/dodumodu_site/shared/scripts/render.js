// DOM building only. No fetch() here — orchestrate.js hands this file data,
// this file turns it into elements. pricing.js supplies the numbers; this
// file only lays them out.
import { computePriceBreakdown, formatNaira, formatTierSummary, getNextTierNudge, resolveDiscountTier } from "./pricing.js";
import { srcsetFor, DEFAULT_SIZES, DEFAULT_QUALITY, intrinsicWidthFor } from "./imageUrls.js";

/**
 * The product carousel.
 *
 * What changed and why it mattered: this used to set `src` on EVERY slide, with a
 * hardcoded 640x640. Setting `src` on eight slides means the browser fetches eight
 * images to show one - on a weak connection that is the difference between seeing
 * the product and waiting for it. It also gave every image the same dimensions
 * regardless of its real size, so the slide reserved space it did not need.
 *
 * Now: slide 0 carries a real `src` and a real `srcset`, and every other slide
 * carries `data-src`/`data-srcset` and is promoted only when it is about to be
 * seen. The browser fetches what is on screen plus the one after it.
 */
export function renderCarousel(container, images, options = {}) {
  if (!images.length) return;
  container.innerHTML = "";

  const widths = options.widths;
  const quality = options.quality || DEFAULT_QUALITY;
  const mode = options.mode;
  const deliveryBase = options.deliveryBase;

  const track = document.createElement("div");
  track.className = "carousel";
  track.setAttribute("role", "region");
  track.setAttribute("aria-label", "Product photos");

  const dotsWrap = document.createElement("div");
  dotsWrap.className = "carousel-dots";

  const slides = images.map((img, i) => {
    const slide = document.createElement("div");
    slide.className = "carousel-slide";

    const el = document.createElement("img");
    el.alt = img.altText || "";
    // The stored dimensions are measured from the file's header on upload, so this
    // reserves the real aspect ratio before anything has downloaded. That is what
    // keeps the page from jumping as images arrive.
    el.width = img.width || intrinsicWidthFor("gallery", widths);
    el.height = img.height || intrinsicWidthFor("gallery", widths);

    const srcset = srcsetFor({ key: img.key || img.url, slot: "gallery", widths, quality, mode, deliveryBase });
    if (srcset) {
      el.srcset = srcset;
      el.sizes = DEFAULT_SIZES.gallery;
    }

    if (i === 0) {
      // Only the first slide is eager. It is the one above the fold.
      el.src = img.url;
      el.fetchPriority = "high";
    } else {
      // Everything else waits. A data attribute is inert: the browser will not
      // fetch an image whose URL is not in src/srcset.
      el.dataset.src = img.url;
      if (srcset) el.dataset.srcset = srcset;
      el.loading = "lazy";
      el.decoding = "async";
    }

    slide.append(el);
    track.append(slide);

    const dot = document.createElement("button");
    dot.className = "carousel-dot";
    dot.setAttribute("aria-label", `Go to photo ${i + 1}`);
    dot.dataset.active = i === 0 ? "true" : "false";
    dot.addEventListener("click", () => {
      slide.scrollIntoView({ behavior: "smooth", inline: "start" });
    });
    dotsWrap.append(dot);
    return slide;
  });

  container.append(track);
  container.append(dotsWrap);

  /**
   * Promote a deferred slide: move data-src into src so the browser fetches it.
   * Kept as a named step because "does the carousel ever download a photo nobody
   * looked at" is a question worth being able to ask of the code directly.
   */
  function promote(el) {
    if (!el || el.dataset.src === undefined) return;
    if (el.dataset.srcset) {
      el.srcset = el.dataset.srcset;
      delete el.dataset.srcset;
    }
    el.src = el.dataset.src;
    delete el.dataset.src;
    el.loading = "eager";
  }

  // An IntersectionObserver promotes a slide slightly before it is visible, so the
  // image is usually already decoded by the time it arrives on screen. The root
  // margin is what buys that head start.
  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        promote(entry.target.querySelector("img"));
        observer.unobserve(entry.target);
      }
    }, { root: track, rootMargin: "200px" });
    for (const slide of slides) observer.observe(slide);
  } else {
    // Without the observer, promoting on the first interaction is strictly better
    // than never: the images are there the moment the customer touches anything.
    for (const slide of slides) promote(slide.querySelector("img"));
  }

  track.addEventListener("scroll", () => {
    const index = Math.round(track.scrollLeft / track.clientWidth);
    [...dotsWrap.children].forEach((dot, i) => {
      dot.dataset.active = i === index ? "true" : "false";
    });
  }, { passive: true });
}

export function renderTestimonials(container, testimonials) {
  if (!testimonials.length) return;
  container.innerHTML = "";
  const list = document.createElement("div");
  list.className = "testimonials-list";

  for (const t of testimonials) {
    const card = document.createElement("div");
    card.className = "testimonial-card";
    card.innerHTML = `
      <img class="testimonial-image" src="${t.url}" alt="" loading="lazy" width="64" height="64">
      <div>
        <p class="testimonial-title">${escapeHtml(t.title)}</p>
        <p class="testimonial-description">${escapeHtml(t.description)}</p>
      </div>
    `;
    list.appendChild(card);
  }
  container.appendChild(list);
}

export function renderDeliveryOptions(selectEl, options) {
  const labels = { today: "Today", tomorrow: "Tomorrow", next_tomorrow: "Day after tomorrow" };
  selectEl.innerHTML = options.map((opt) => `<option value="${opt}">${labels[opt]}</option>`).join("");
}

// Only rendered when a product has more than one package option (§6 step 1
// field order note). If there's zero or one option, the field stays hidden
// and orchestrate.js falls back to the product's base price.
export function renderPackageSelector(selectEl, fieldEl, packageOptions) {
  if (!packageOptions || packageOptions.length < 2) {
    fieldEl.style.display = "none";
    return;
  }
  fieldEl.style.display = "";
  selectEl.innerHTML = packageOptions
    .map((opt) => `<option value="${opt.id}">${escapeHtml(opt.label)}</option>`)
    .join("");
}

// Quantity stepper: plain number input under the hood (works with JS
// disabled per §6 step 1 — the buttons are inert without JS, the input
// alone still works), with +/- buttons wired up once JS runs.
export function renderQuantityStepper(container, quantity, maxOrderQuantity, onChange) {
  // Hand-off flag read by the product page's inline fallback script: from here
  // on the bundled app owns the +/- buttons, so the fallback must not also fire.
  container.dataset.enhanced = "true";
  const minusBtn = container.querySelector(".quantity-stepper-btn[data-action='decrement']");
  const plusBtn = container.querySelector(".quantity-stepper-btn[data-action='increment']");
  const input = container.querySelector("input[name='quantity']");

  input.max = maxOrderQuantity;
  input.value = quantity;
  minusBtn.disabled = quantity <= 1;
  plusBtn.disabled = quantity >= maxOrderQuantity;

  minusBtn.onclick = () => onChange(Math.max(1, quantity - 1));
  plusBtn.onclick = () => onChange(Math.min(maxOrderQuantity, quantity + 1));
  input.oninput = () => {
    const parsed = parseInt(input.value, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= maxOrderQuantity) onChange(parsed);
  };
  input.onblur = () => {
    // Snap back to a valid value if the customer left the field empty/out of range.
    const parsed = parseInt(input.value, 10);
    const clamped = Number.isInteger(parsed) ? Math.min(maxOrderQuantity, Math.max(1, parsed)) : 1;
    if (clamped !== quantity) onChange(clamped);
  };
}

// The running price that sits BESIDE the quantity stepper, so the customer
// watches the number move as they tap + / -. Shows the total, then the unit
// price, a badge the moment a discount kicks in, and the ladder of EVERY
// configured discount with the active one marked — so an increase is visibly
// rewarded instead of silently changing a total further down the page. The
// itemised .price-breakdown below stays the invoice; this is the feedback
// next to the control.
export function renderLivePrice(container, unitPrice, quantity, tiers) {
  if (!container) return null;
  const breakdown = computePriceBreakdown(unitPrice, quantity, tiers);
  const activeTier = breakdown.discountPercent > 0 ? resolveDiscountTier(quantity, tiers) : null;

  const parts = [
    `<span class="quantity-price-total">${formatNaira(breakdown.amount)}</span>`,
    `<span class="quantity-price-each">${formatNaira(breakdown.unitPrice)} &times; ${breakdown.quantity}</span>`,
  ];

  if (breakdown.discountPercent > 0) {
    parts.push(`
      <span class="quantity-price-badge" data-role="discount">
        ${breakdown.discountPercent}% off &middot; save ${formatNaira(breakdown.discountAmount)}
      </span>
    `);
  }

  // Labels come from admin config, so the discounts the customer reads here
  // can never drift from the ones the server will actually apply.
  const labelledTiers = tiers
    .filter((t) => t.discountPercent > 0 && t.label)
    .sort((a, b) => a.minQuantity - b.minQuantity);

  if (labelledTiers.length) {
    parts.push(`<span class="quantity-price-ladder-title">Every discount</span>`);
    parts.push(`
      <ul class="quantity-price-ladder">
        ${labelledTiers.map((t) => {
          const isActive = t === activeTier;
          return `<li class="quantity-price-tier" data-active="${isActive}"${isActive ? ' aria-current="true"' : ""}>` +
            `<span>${escapeHtml(t.label)}</span><span>${t.discountPercent}%</span></li>`;
        }).join("")}
      </ul>
    `);
  }

  container.innerHTML = parts.join("");
  return breakdown;
}

// The single price-breakdown block: unit price, quantity, subtotal, a
// discount line (only when discountPercent > 0), the total, a "you saved"
// line, and — only right at a tier boundary — the next-tier nudge. All one
// block, no separate promo banner (§6 step 4).
export function renderPriceBreakdown(container, unitPrice, quantity, tiers) {
  const breakdown = computePriceBreakdown(unitPrice, quantity, tiers);
  const nudge = getNextTierNudge(quantity, tiers);
  const tierSummary = formatTierSummary(tiers);

  const rows = [
    `<div class="price-breakdown-row"><span>Unit price</span><span>${formatNaira(breakdown.unitPrice)}</span></div>`,
    `<div class="price-breakdown-row"><span>Quantity</span><span>${breakdown.quantity}</span></div>`,
    `<div class="price-breakdown-row"><span>Subtotal</span><span>${formatNaira(breakdown.subtotal)}</span></div>`,
  ];

  if (breakdown.discountPercent > 0) {
    rows.push(`
      <div class="price-breakdown-row price-breakdown-discount">
        <span>Discount (${breakdown.discountPercent}%)</span>
        <span>&minus;${formatNaira(breakdown.discountAmount)}</span>
      </div>
    `);
  }

  rows.push(`
    <div class="price-breakdown-row" data-emphasis="true">
      <span>Total</span><span>${formatNaira(breakdown.amount)}</span>
    </div>
  `);

  if (breakdown.discountAmount > 0) {
    rows.push(`<div class="price-breakdown-saved">You saved ${formatNaira(breakdown.discountAmount)}</div>`);
  }

  if (nudge) {
    rows.push(`<div class="tier-nudge"><svg class="icon"><use href="#icon-check"></use></svg> ${escapeHtml(nudge)}</div>`);
  }

  if (tierSummary) {
    rows.push(`<div class="tier-summary">${escapeHtml(tierSummary)}</div>`);
  }

  container.innerHTML = rows.join("");
  return breakdown;
}

export function setFieldError(fieldEl, message) {
  fieldEl.dataset.invalid = message ? "true" : "false";
  const errorEl = fieldEl.querySelector(".field-error");
  if (errorEl) errorEl.textContent = message || "";
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
