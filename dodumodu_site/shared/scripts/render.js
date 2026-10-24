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

// Static fallback slides (picsum.photos — the same source already used for the
// hero image) so the carousel still renders and works when there is no backend.
// Two slides only while testing; each carries a real srcset so the browser
// never downloads more than it will display.
const CAROUSEL_FALLBACK_IMAGES = [
  { url: "https://picsum.photos/seed/glow-serum-1/640/640", altText: "Radiance Glow Serum bottle with dropper" },
  { url: "https://picsum.photos/seed/glow-serum-2/640/640", altText: "Serum texture close-up" },
];

export function renderCarousel(container, images, options = {}) {
  const list = images && images.length ? images : CAROUSEL_FALLBACK_IMAGES;
  if (!list.length) return;
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

  // ---- prev / next arrows (inline SVG = zero extra requests) ----
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "carousel-arrow carousel-arrow--prev";
  prevBtn.setAttribute("aria-label", "Previous photo");
  prevBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>`;

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "carousel-arrow carousel-arrow--next";
  nextBtn.setAttribute("aria-label", "Next photo");
  nextBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>`;

  track.appendChild(prevBtn);
  track.appendChild(nextBtn);

  let currentIndex = 0;
  let timer = null;
  const AUTOPLAY_MS = 5000;

  const slides = list.map((img, i) => {
    const slide = document.createElement("div");
    slide.className = "carousel-slide";

    const el = document.createElement("img");
    el.alt = img.altText || "";
    el.width = img.width || intrinsicWidthFor("gallery", widths);
    el.height = img.height || intrinsicWidthFor("gallery", widths);

    const srcset = srcsetFor({ key: img.key || img.url, slot: "gallery", widths, quality, mode, deliveryBase });
    if (srcset) {
      el.srcset = srcset;
      el.sizes = DEFAULT_SIZES.gallery;
    }

    if (i === 0) {
      el.src = img.url;
      el.fetchPriority = "high";
      el.loading = "eager";
      el.decoding = "async";
    } else {
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
      slide.scrollIntoView();
      setIndex(i);
      resetAutoplay();
    });
    dotsWrap.append(dot);
    return slide;
  });

  container.append(track);
  container.append(dotsWrap);

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
    for (const slide of slides) promote(slide.querySelector("img"));
  }

  function setIndex(index) {
    currentIndex = Math.min(Math.max(index, 0), list.length - 1);
    updateDots();
  }

  function updateDots() {
    [...dotsWrap.children].forEach((dot, i) => {
      dot.dataset.active = i === currentIndex ? "true" : "false";
    });
  }

  const scrollBySlide = (delta) => {
    const step = track.clientWidth || 0;
    if (!step) return;
    let target = currentIndex + delta;
    if (target < 0) target = list.length - 1;
    else if (target > list.length - 1) target = 0;
    track.scrollBy({ left: (target - currentIndex) * step, behavior: "smooth" });
    setIndex(target);
    resetAutoplay();
  };

  prevBtn.addEventListener("click", () => scrollBySlide(-1));
  nextBtn.addEventListener("click", () => scrollBySlide(1));

  function startAutoplay() {
    stopAutoplay();
    timer = setTimeout(() => {
      scrollBySlide(1);
      startAutoplay();
    }, AUTOPLAY_MS);
  }

  function stopAutoplay() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function resetAutoplay() {
    stopAutoplay();
    startAutoplay();
  }

  track.addEventListener("mouseenter", stopAutoplay);
  track.addEventListener("mouseleave", startAutoplay);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAutoplay();
    else startAutoplay();
  });

  track.addEventListener("scroll", () => {
    const index = Math.round(track.scrollLeft / track.clientWidth);
    setIndex(index);
    resetAutoplay();
  }, { passive: true });

  setIndex(0);
  startAutoplay();
}

export function renderTestimonials(container, testimonials) {
  if (!testimonials.length) return;
  container.innerHTML = "";
  const list = document.createElement("div");
  list.className = "testimonials-list";

  for (const t of testimonials) {
    const card = document.createElement("div");
    card.className = "testimonial-card";
    const hasPhoto = Boolean(t.url);
    const avatar = !hasPhoto
      ? `<span class="testimonial-avatar" aria-hidden="true">${escapeHtml((t.title || "?").trim().charAt(0).toUpperCase())}</span>`
      : `<img class="testimonial-image" src="${t.url}" alt="" loading="lazy" decoding="async" width="64" height="64">`;
    card.innerHTML = `
      ${avatar}
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

export function renderQuantityStepper(container, quantity, maxOrderQuantity, onChange) {
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
    const parsed = parseInt(input.value, 10);
    const clamped = Number.isInteger(parsed) ? Math.min(maxOrderQuantity, Math.max(1, parsed)) : 1;
    if (clamped !== quantity) onChange(clamped);
  };
}

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