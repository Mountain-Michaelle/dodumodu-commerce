import { getPageData, createOrder } from "./apiClient.js";
import {
  renderCarousel, renderTestimonials, renderDeliveryOptions,
  renderPackageSelector, renderQuantityStepper, renderPriceBreakdown, renderLivePrice, setFieldError,
} from "./render.js";
import { validateOrderForm, collectOrderPayload } from "./validate.js";
import { parsePaymentRules, decideCod, codHint } from "./codRules.js";
import { deliveryChoices } from "./deliveryOptions.js";
import { saveDraft, loadDraft, applyDraft, clearDraft } from "./draftStore.js";
import { armTurnstile, ensureToken, resetTurnstile } from "./turnstile.js";

import "./stick.js";

const IDEMPOTENCY_KEY_STORAGE = "skincare_order_idempotency_key";
// Draft writes are debounced: localStorage is synchronous and the customer
// types one character at a time.

// sessionStorage, not localStorage: must not survive the tab closing, and
// must not get reused on a genuinely new visit days later. Not a plain JS
// variable either: must survive an accidental refresh — if the server-side
// insert succeeds but the response never reaches the browser and the
// customer refreshes, a plain variable would generate a *new* key and
// create a second order. sessionStorage means the retry after refresh
// reuses the same key and lands on the same order.
function getOrCreateIdempotencyKey() {
  let key = sessionStorage.getItem(IDEMPOTENCY_KEY_STORAGE);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(IDEMPOTENCY_KEY_STORAGE, key);
  }
  return key;
}

function clearIdempotencyKey() {
  sessionStorage.removeItem(IDEMPOTENCY_KEY_STORAGE);
}

// Mirrors orderService.ts's computeUnitPrice — a display convenience only,
// the server always recomputes for real. §8.8's "must agree" rule is about
// the discount formula; this part is just "which price the discount applies to".
function computeUnitPrice(product, packageOptions, packageId) {
  if (!packageOptions.length) return product.price;
  const chosen = packageOptions.find((o) => o.id === packageId) || packageOptions[0];
  return chosen.price ?? product.price;
}

export function initProductPage({ slug, productId }) {
  try{
  const form = document.getElementById("order-form");
  if (!form) return;
  // Hand-off flag read by the product page's inline progressive-enhancement
  // script: once the bundled app owns the form, that fallback stays quiet.
  form.dataset.enhanced = "true";

  const submitButton = form.querySelector(".submit-button");
  const statusEl = form.querySelector(".form-status");
  const retryBanner = document.getElementById("retry-banner");
  const manualRetryButton = document.getElementById("manual-retry-button");
  const lateWarning = document.getElementById("late-warning");
  const deliverySelect = form.elements["deliveryDate"];
  const carouselContainer = document.getElementById("carousel");
  const testimonialsContainer = document.getElementById("testimonials");
  const packageField = document.getElementById("package-field");
  const packageSelect = form.elements["packageId"];
  const quantityStepper = document.getElementById("quantity-stepper");
  const quantityPriceEl = document.getElementById("quantity-price");
  const priceBreakdownEl = document.getElementById("price-breakdown");
  const stateSelect = form.elements["state"];
  const paymentField = form.querySelector('[data-field="paymentMethod"]');
  const codHintEl = document.getElementById("cod-hint");

  // COD rules exactly as page-data published them. `null` until the API
  // answers, in which case the form stays neutral — the HTML's checked
  // "Pay now" is already the safe default, and orderService.ts is the only
  // voice. An empty rule set from the server is NOT null: that is COD being
  // switched off, and the option goes grey.
  let paymentRules = null;

  let lastAttemptPayload = null;

  // Pricing state — filled in once page data arrives, then updated purely
  // client-side on every quantity/package change (no network request).
  const pricing = {
    product: null,
    packageOptions: [],
    discountTiers: [],
    maxOrderQuantity: 20, // safe default until page-data arrives
    quantity: 1,
    packageId: null,
  };

  function rerenderPricing() {
    const unitPrice = computeUnitPrice(pricing.product, pricing.packageOptions, pricing.packageId);
    // The number beside the stepper first — that's what the customer is
    // watching while they tap +/- — then the itemised breakdown below it.
    renderLivePrice(quantityPriceEl, unitPrice, pricing.quantity, pricing.discountTiers);
    renderPriceBreakdown(priceBreakdownEl, unitPrice, pricing.quantity, pricing.discountTiers);
    renderQuantityStepper(quantityStepper, pricing.quantity, pricing.maxOrderQuantity, (newQuantity) => {
      pricing.quantity = newQuantity;
      rerenderPricing();
    });
    // Pay-on-delivery has a quantity ceiling as well as a state list, so every
    // quantity change re-runs that gate.
    refreshPaymentOptions();
  }

  // Download the anti-spam challenge only as the customer approaches the form.
  // Free on the critical path: the first paint, the hero image and the scroll
  // down to the form all happen before a single byte of Turnstile is requested.
  armTurnstile(form);

  // First paint already happened from static HTML — the quantity input is a
  // plain <input type="number"> until this resolves. Fetch page data (one
  // request covers product/packages/discount tiers/images/testimonials) and
  // render everything that depends on it right after.
  const __r = async () => {
    try {
      const data = await getPageData(slug);
      pricing.product = data.product;
      pricing.packageOptions = data.product.packageOptions || [];
      pricing.discountTiers = data.discountTiers;
      pricing.maxOrderQuantity = data.maxOrderQuantity;
      pricing.packageId = pricing.packageOptions[0]?.id ?? null;
      paymentRules = parsePaymentRules(data.paymentRules);

      renderPackageSelector(packageSelect, packageField, pricing.packageOptions);
      rerenderPricing();

      const images = (data.images && data.images.length)
        ? data.images.map((img) => ({ url: mediaUrl(img.r2Key), altText: img.altText }))
        : null;
      renderCarousel(carouselContainer, images);
      renderTestimonials(testimonialsContainer, (data.testimonials || []).map((t) => ({ url: mediaUrl(t.r2Key), ...t })));
      hydrateDeliveryDates(data.deliveryOptions);
      restoreDraft();
      refreshPaymentOptions();
    } catch (err) {
      // No backend: still render the carousel with static fallback images so the
      // gallery works end-to-end without any API. The hero image in static HTML
      // stays as the first slide; renderCarousel replaces it with the full set.
      if (carouselContainer) renderCarousel(carouselContainer, null);
      if (quantityPriceEl) quantityPriceEl.innerHTML = "";
    }
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(__r); else setTimeout(__r, 1);

  packageSelect.addEventListener("change", () => {
    pricing.packageId = packageSelect.value;
    rerenderPricing();
  });

  deliverySelect.addEventListener("change", () => {
    const options = offeredDeliveryChoices().map((o) => o.value);
    lateWarning.dataset.visible = deliverySelect.value === "today" && !options.includes("today")
      ? "true" : "false";
  });

  // ---- Delivery dates -----------------------------------------------------
  // page-data's list is the authority (the server drops "today" once it is past
  // the 3pm WAT cutoff). The device clock can only ever remove an option — for
  // the page that has been sitting open across the cutoff — never invent one,
  // because a slow or wrong device clock must not promise same-day dispatch.
  function allowedDeliveryOptions(serverOptions) {
    const clockAllows = new Set(deliveryChoices());
    const fromServer = (serverOptions && serverOptions.length ? serverOptions : ["tomorrow", "next_tomorrow"]);
    const filtered = fromServer.filter((opt) => clockAllows.has(opt));
    return filtered.length ? filtered : fromServer.filter((opt) => opt !== "today");
  }

  function offeredDeliveryChoices() {
    return [...deliverySelect.options].filter((o) => o.value);
  }

  // Rebuilds the select, keeping a choice that is still orderable and dropping
  // one that has aged out (e.g. "today" restored from a draft saved at 11am and
  // reopened at 6pm). An empty option is added so nothing is silently
  // pre-selected: validateOrderForm then asks for a date rather than the page
  // assuming one.
  function hydrateDeliveryDates(serverOptions) {
    const choices = allowedDeliveryOptions(serverOptions);
    const previous = deliverySelect.value;
    renderDeliveryOptions(deliverySelect, choices);
    deliverySelect.insertAdjacentHTML("afterbegin", '<option value="">Select a date</option>');
    deliverySelect.value = choices.includes(previous) ? previous : "";
    lateWarning.dataset.visible = "false";
  }

  // ---- Pay on delivery ----------------------------------------------------
  /**
   * Presents the COD gate the server already decided. The decision itself lives
   * in codRules.js (a mirror of codPolicyService.ts), so the greyed-out option
   * and the sentence beside it can never disagree with the 400 the API would
   * return. The option stays *visible* when unavailable — hiding it leaves the
   * customer wondering whether they missed a checkbox, and the reason is the
   * thing that converts them to "Pay now".
   */
  function refreshPaymentOptions() {
    const chosenState = stateSelect?.value || "";
    const decision = decideCod(chosenState, pricing.quantity, paymentRules);
    const unavailable = decision.allowed === false;

    for (const input of form.querySelectorAll('input[name="paymentMethod"]')) {
      if (input.value !== "cod") continue;
      input.disabled = unavailable;
      input.closest(".radio-option")?.setAttribute("data-unavailable", unavailable ? "true" : "false");
    }

    // Never leave a disabled radio checked: that would submit a payment method
    // the customer can no longer see as chosen.
    if (unavailable && form.elements["paymentMethod"].value === "cod") {
      form.elements["paymentMethod"].value = "pay_now";
    }

    if (codHintEl) {
      codHintEl.textContent = chosenState && paymentRules ? codHint(chosenState, pricing.quantity, paymentRules) : "";
    }

    if (paymentField?.dataset.invalid === "true" && !unavailable) setFieldError(paymentField, "");
  }

  stateSelect?.addEventListener("change", refreshPaymentOptions);

  // Switching payment method is a different intent, so the key minted for the
  // previous one must not travel with it — a key from a failed Pay-now attempt
  // replayed against a COD submit (or the reverse) is refused server-side, and
  // paying for that rejected round trip teaches the customer nothing. Only a
  // genuine user click fires `change` on a radio: the gate's programmatic
  // fall-back above assigns `.value` directly and never lands here.
  for (const radio of form.querySelectorAll('input[name="paymentMethod"]')) {
    radio.addEventListener("change", clearIdempotencyKey);
  }

  // ---- Draft --------------------------------------------------------------
  let draftTimer = null;
  form.addEventListener("input", (event) => {
    if (event.target?.name === "turnstileToken") return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveDraft(form, slug), 800);
  });

  function restoreDraft() {
    const draft = loadDraft(slug);
    if (!draft) return;
    const restored = applyDraft(form, draft);
    if (!restored) return;
    // A saved date can stop being orderable while the tab was closed.
    if (deliverySelect.value && !offeredDeliveryChoices().some((o) => o.value === deliverySelect.value)) {
      deliverySelect.value = "";
    }
    statusEl.textContent = "Draft restored.";
    form.addEventListener("input", () => { statusEl.textContent = ""; }, { once: true });
  }

  /**
   * Puts the form back exactly where a first-time visitor would find it, so the
   * page being left behind is one that can still take another order.
   *
   * This has to run BEFORE the navigation, not after it. The browser snapshots
   * the document as it unloads, for the back/forward cache — so navigating with
   * the button still disabled and the fields still full means the customer's own
   * Back button hands back that mid-flight page: spinner still turning, the
   * details of an order that has already been placed still on screen. Resetting
   * after the fact would be too late, because the snapshot has been taken.
   */
  function restForm() {
    submitButton.disabled = false;
    submitButton.dataset.loading = "false";
    form.reset();
    // The quantity input and the price live in two different places: the input
    // is DOM, so reset() puts it back to 1, but `pricing` is module state the
    // reset cannot reach. Left alone, the stepper would read 1 next to a total
    // still priced for the quantity that was just ordered.
    pricing.quantity = 1;
    pricing.packageId = pricing.packageOptions[0]?.id ?? null;
    // Only when there is a package to select — pointing a <select> at a value
    // it does not offer leaves nothing selected, which would then fail the
    // required-field check on the customer's next submit.
    if (pricing.packageId) packageSelect.value = pricing.packageId;
    for (const field of form.querySelectorAll(".field")) setFieldError(field, "");
    if (retryBanner) retryBanner.dataset.visible = "false";
    if (lateWarning) lateWarning.dataset.visible = "false";
    if (statusEl) statusEl.textContent = "";
    // Re-renders the breakdown at one unit and re-runs the COD gate against the
    // now-empty state, which makes this the page's genuine first-paint state.
    rerenderPricing();
  }

  // A page restored from the back/forward cache keeps its module state. The DOM
  // is already clean — restForm() ran before the navigation that created the
  // snapshot — but the Turnstile token in it was spent on the order that has
  // just been placed, so drop it before the customer can try again.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resetTurnstile();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const requirePackage = pricing.packageOptions.length >= 2;
    const { valid, errors } = validateOrderForm(form, {
      maxOrderQuantity: pricing.maxOrderQuantity, requirePackage,
    });
    for (const field of form.querySelectorAll(".field")) {
      const name = field.dataset.field;
      setFieldError(field, errors[name]);
    }
    if (!valid) return;

    // Re-run the COD gate at submit time. Only a courtesy — orderService.ts
    // makes this exact decision again before it prices anything, so a customer
    // on an old tab that never loaded the rules still gets refused server-side.
    // `paymentRules` being null means "page-data never answered": stay silent
    // and let the server be the only voice.
    if (paymentRules && form.elements["paymentMethod"].value === "cod") {
      const decision = decideCod(stateSelect?.value || "", pricing.quantity, paymentRules);
      if (!decision.allowed) {
        setFieldError(paymentField, decision.message);
        statusEl.textContent = decision.message;
        return;
      }
    }

    submitButton.disabled = true;
    submitButton.dataset.loading = "true";
    retryBanner.dataset.visible = "false";
    statusEl.textContent = "Placing your order...";

    // The challenge is only downloaded when the form is near the viewport or
    // the customer touches a field, so on a fast connection the token is
    // usually already sitting in the hidden input and this resolves at once.
    // On a slow one we wait for it here rather than posting an empty token the
    // API would reject with a 400 the customer cannot act on.
    try {
      await ensureToken();
    } catch (err) {
      submitButton.disabled = false;
      submitButton.dataset.loading = "false";
      statusEl.textContent = "Security check failed. Tap Place order again.";
      return;
    }

    const idempotencyKey = getOrCreateIdempotencyKey();
    const payload = collectOrderPayload(form, productId);
    payload.turnstileToken = form.elements["turnstileToken"]?.value || "";
    lastAttemptPayload = payload;

    await submitWithRetry(payload, idempotencyKey, { statusEl, retryBanner, submitButton });
  });

  manualRetryButton.addEventListener("click", async () => {
    if (!lastAttemptPayload) return;
    manualRetryButton.disabled = true;
    retryBanner.dataset.visible = "false";
    submitButton.disabled = true;
    submitButton.dataset.loading = "true";
    await submitWithRetry(lastAttemptPayload, getOrCreateIdempotencyKey(), { statusEl, retryBanner, submitButton });
    manualRetryButton.disabled = false;
  });

  async function submitWithRetry(payload, idempotencyKey, ui) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await createOrder(payload, idempotencyKey);
        clearIdempotencyKey();
        // The order exists — the draft of the same details must not come back
        // on the next visit and re-fill a second order for the same person.
        clearTimeout(draftTimer);
        clearDraft(slug);
        // Rest the page before leaving it, not after: see restForm(). By the
        // time the browser caches this document for the Back button, the form
        // must already look untouched.
        restForm();
        // The thank-you page shows this verbatim — it's the server's
        // breakdown, never recomputed in the browser (§6 step 9).
        sessionStorage.setItem("skincare_last_order", JSON.stringify(result));
        window.location.href = "/thank-you.html";
        return;
      } catch (err) {
        if (err.status && err.status !== 429) {
          // A real validation/business error (including 500s the server chose
          // to return as a response) — retrying won't help.
          //
          // The attempt is over, so the idempotency key goes too: the next
          // submit is a new intent. Keeping the key would replay this
          // rejection forever — and any order an older build half-created
          // before failing would keep answering in place of the one the
          // customer now wants.
          clearIdempotencyKey();
          if (err.fields) {
            for (const field of form.querySelectorAll(".field")) {
              const name = field.dataset.field;
              const message = err.fields[name]?.[0];
              if (message) setFieldError(field, message);
            }
          }
          ui.statusEl.textContent = err.message || "Something went wrong.";
          ui.submitButton.disabled = false;
          ui.submitButton.dataset.loading = "false";
          return;
        }
        if (attempt < 2) {
          ui.statusEl.textContent = "Still trying...";
          await new Promise((resolve) => setTimeout(resolve, [800, 1600, 3200][attempt]));
        }
      }
    }
    // Idempotency makes retries safe, but we still don't hammer a dead connection forever.
    ui.statusEl.textContent = "";
    ui.retryBanner.dataset.visible = "true";
    ui.submitButton.disabled = false;
    ui.submitButton.dataset.loading = "false";
  }
} catch (e) {}
}

// Images live in object storage; IMAGE_DELIVERY_BASE (injected at build time)
// is the public origin or path in front of it. A value that is already an
// absolute http(s) URL is used as-is, which is how a database row can point at
// a real CDN asset instead of a storage key.
function mediaUrl(r2Key) {
  if (/^https?:\/\//i.test(r2Key)) return r2Key;
  const base = window.IMAGE_DELIVERY_BASE || "/media";
  return `${base}/${r2Key}`;
}

// Auto-run: product pages set data-slug/data-product-id on <body>. Bundled as
// a plain (non-module) IIFE and loaded with `defer`, so the DOM already exists
// by the time this runs.
const body = document.body;
if (body?.dataset.slug && body?.dataset.productId) {
  initProductPage({ slug: body.dataset.slug, productId: Number(body.dataset.productId) });
}
