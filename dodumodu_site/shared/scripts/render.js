// DOM building only. No fetch() here — orchestrate.js hands this file data,
// this file turns it into elements. pricing.js supplies the numbers; this
// file only lays them out.
import { computePriceBreakdown, formatNaira, formatTierSummary, getNextTierNudge, resolveDiscountTier } from "./pricing.js";
import { srcsetFor, imageUrl, DEFAULT_SIZES, DEFAULT_QUALITY, DEFAULT_WIDTHS, intrinsicWidthFor } from "./imageUrls.js";

/**
 * The product carousel.
 *
 * Fast: the server prints the first photo as a real <img> (src + srcset + preload) and puts the
 * whole gallery in data-gallery on #carousel, so this runs immediately with no API round trip.
 * Every photo is requested through the image delivery base at the widths in `srcset`, so the
 * browser only downloads what it will display; photos after the first load natively (lazy).
 *
 * Layout: the track scrolls, the controls do not. Arrows used to live inside the scrolling track,
 * so they slid away with the first swipe. They now sit in a fixed bar below it: < dots >.
 *
 * images: [{ key, altText }] where key is an R2 key or an absolute URL. No images: the markup the
 * server printed is left alone.
 */
const ARROW = {
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7"/></svg>',
};

export function renderCarousel(container, images, options = {}) {
  const list = (images || []).filter((img) => img && (img.key || img.url));
  // A published page already printed the finished track (build/render-core.mjs): the slides in the page are the ones that
  // are painted and decoded, so they are KEPT and only wired up. Rebuilding them is what blanked the hero on slow phones.
  const printed = container.querySelector(".carousel");
  if (!printed && !list.length) return;
  if (!printed) container.innerHTML = "";

  const { widths, mode, deliveryBase } = options;
  const quality = options.quality || DEFAULT_QUALITY;
  const slot = "gallery";
  const srcWidth = (widths && widths[slot] ? widths[slot] : DEFAULT_WIDTHS[slot]);
  const mid = srcWidth[Math.min(1, srcWidth.length - 1)];
  const side = intrinsicWidthFor(slot, widths);

  const wrap = printed ? printed.parentNode : document.createElement("div");
  wrap.className = "carousel-wrap";
  const track = printed || document.createElement("div");
  if (!printed) {
    track.className = "carousel";
    track.setAttribute("role", "region");
    track.setAttribute("aria-roledescription", "carousel");
    track.setAttribute("aria-label", "Product photos");
    track.tabIndex = 0; // a sideways-scrolling region must be reachable and scrollable from the keyboard
  }

  const nav = document.createElement("div");
  nav.className = "carousel-nav";
  const dotsWrap = document.createElement("div");
  dotsWrap.className = "carousel-dots";

  const mkArrow = (dir, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `carousel-arrow carousel-arrow--${dir}`;
    b.setAttribute("aria-label", label);
    b.innerHTML = ARROW[dir];
    return b;
  };
  const prevBtn = mkArrow("prev", "Previous photo");
  const nextBtn = mkArrow("next", "Next photo");

  let currentIndex = 0;
  let timer = null;
  const AUTOPLAY_MS = 5000;

  const slides = printed ? [...track.children] : list.map((img) => {
    const key = img.key || img.url;
    const slide = document.createElement("div");
    slide.className = "carousel-slide";
    const el = document.createElement("img");
    el.alt = img.altText || "";
    el.width = side;
    el.height = side;
    el.decoding = "async";
    el.src = imageUrl({ key, width: mid, quality: quality[slot], mode, deliveryBase });
    const srcset = srcsetFor({ key, slot, widths, quality, mode, deliveryBase });
    if (srcset) { el.srcset = srcset; el.sizes = DEFAULT_SIZES[slot]; }
    if (track.children.length === 0) { el.fetchPriority = "high"; el.loading = "eager"; } else { el.loading = "lazy"; }
    slide.append(el);
    track.append(slide);
    return slide;
  });
  slides.forEach((_, i) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "carousel-dot";
    dot.setAttribute("aria-label", `Go to photo ${i + 1}`);
    dot.addEventListener("click", () => goTo(i, true));
    dotsWrap.append(dot);
  });
  list.length = slides.length; // one count for everything below, whether the slides were printed or built

  nav.append(prevBtn, dotsWrap, nextBtn);
  if (!printed) wrap.append(track);
  if (slides.length > 1) wrap.append(nav);
  if (!printed) container.append(wrap);

  function paint() {
    [...dotsWrap.children].forEach((d, i) => { d.dataset.active = i === currentIndex ? "true" : "false"; });
    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex === list.length - 1;
  }

  function goTo(i, byUser) {
    if (byUser) stopAutoplay(true);
    const target = Math.min(Math.max(i, 0), list.length - 1);
    track.scrollTo({ left: slides[target].offsetLeft, behavior: "smooth" });
    currentIndex = target;
    paint();
  }

  prevBtn.addEventListener("click", () => goTo(currentIndex - 1, true));
  nextBtn.addEventListener("click", () => goTo(currentIndex + 1, true));

  // The nearest slide to the scroll position wins, so swipes, arrows and dots all agree.
  track.addEventListener("scroll", () => {
    // One division, not a layout read per slide on every scroll frame.
    const stride = slides.length > 1 ? slides[1].offsetLeft - slides[0].offsetLeft : 1;
    const best = Math.min(slides.length - 1, Math.max(0, Math.round(track.scrollLeft / (stride || 1))));
    if (best !== currentIndex) { currentIndex = best; paint(); }
  }, { passive: true });

  // Autoplay is a courtesy, not a trap: it stops for good on the first touch, click or hover.
  let autoplayOn = list.length > 1;
  function stopAutoplay(forever) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (forever) autoplayOn = false;
  }
  function startAutoplay() {
    if (!autoplayOn || timer) return;
    timer = setTimeout(() => {
      timer = null;
      goTo(currentIndex === list.length - 1 ? 0 : currentIndex + 1, false);
      startAutoplay();
    }, AUTOPLAY_MS);
  }
  for (const ev of ["pointerdown", "touchstart", "mouseenter", "focusin"]) {
    track.addEventListener(ev, () => stopAutoplay(true), { passive: true });
  }
  document.addEventListener("visibilitychange", () => (document.hidden ? stopAutoplay(false) : startAutoplay()));

  // The slides only auto-advance while the carousel is on screen. Left running while the customer reads further down, the
  // timer kept scrolling, decoding and repainting an invisible track every few seconds - on a small Android phone that
  // is what left the hero stale or blank when they scrolled back up.
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver((entries) => {
      for (const e of entries) (e.isIntersecting ? startAutoplay() : stopAutoplay(false));
    }).observe(track);
  } else {
    startAutoplay();
  }
  paint();
}

export function renderTestimonials(container, testimonials) {
  if (!testimonials.length) return;
  container.innerHTML = "";
  const list = document.createElement("div");
  list.className = "testimonials-list";

  for (const t of testimonials) {
    const card = document.createElement("div");
    const title = escapeHtml(t.title);
    const text = `<div class="testimonial-body"><p class="testimonial-title">${title}</p><p class="testimonial-description">${escapeHtml(t.description)}</p></div>`;
    // Same three shapes build-time rendering prints (build/render-core.mjs): screenshot under its text, big photo, initial tile.
    if (t.url && t.kind === "whatsapp") {
      card.className = "testimonial-card is-screenshot";
      card.innerHTML = `${text}<img class="testimonial-screenshot" src="${t.url}" alt="WhatsApp message from ${title}" loading="lazy" decoding="async">`;
    } else if (t.url) {
      card.className = "testimonial-card has-photo";
      card.innerHTML = `<img class="testimonial-image" src="${t.url}" alt="" loading="lazy" decoding="async" width="480" height="600">${text}`;
    } else {
      card.className = "testimonial-card";
      card.innerHTML = `<span class="testimonial-avatar" aria-hidden="true">${escapeHtml((t.title || "?").trim().charAt(0).toUpperCase())}</span>${text}`;
    }
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