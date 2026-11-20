import { getPageData, createOrder } from "./apiClient.js";
import {
  renderCarousel, renderTestimonials, renderDeliveryOptions,
  renderPackageSelector, renderQuantityStepper, renderPriceBreakdown, renderLivePrice, setFieldError,
} from "./render.js";
import { validateOrderForm, collectOrderPayload } from "./validate.js";
import { parsePaymentRules, decideCod, codHint } from "./codRules.js";
import { deliveryChoices } from "./deliveryOptions.js";
import { saveDraft, loadDraft, applyDraft, clearDraft } from "./draftStore.js";
import { armTurnstile, tokenForSubmit, checkConfigured, waitForToken, resetTurnstile, onNextToken, checkFailed } from "./turnstile.js";

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
// sessionStorage can throw (private mode, storage disabled), so the key is also kept in memory: a retry in the same page
// load still reuses it even when storage is unavailable.
let memoryKey = null;
function newKey() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* fall through */ }
  // Older Android WebViews have no randomUUID: build a v4 UUID from getRandomValues, or Math.random as a last resort.
  const bytes = new Uint8Array(16);
  try { crypto.getRandomValues(bytes); } catch (e) { for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256); }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [];
  for (let i = 0; i < 16; i++) h.push((bytes[i] + 256).toString(16).slice(1));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
}
function getOrCreateIdempotencyKey() {
  let key = null;
  try { key = sessionStorage.getItem(IDEMPOTENCY_KEY_STORAGE); } catch (e) { /* storage unavailable */ }
  key = key || memoryKey;
  if (!key) key = newKey();
  memoryKey = key;
  try { sessionStorage.setItem(IDEMPOTENCY_KEY_STORAGE, key); } catch (e) { /* kept in memory */ }
  return key;
}

function clearIdempotencyKey() {
  memoryKey = null;
  try { sessionStorage.removeItem(IDEMPOTENCY_KEY_STORAGE); } catch (e) { /* nothing to clear */ }
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

  // The anti-spam check is armed here but does NOTHING until the customer first types in or changes a field of this form
  // (see turnstile.js): no request, no script, no timer at load, reload, scroll or idle.
  armTurnstile(form);

  // The gallery, testimonials, prices and delivery options are all printed into a published page, so rendering needs no
  // backend request. Only a page built without them (local dev, the source page) falls back to the API.
  try {
    const gallery = JSON.parse(carouselContainer?.dataset.gallery || "null");
    if (carouselContainer?.querySelector(".carousel")) {
      renderCarousel(carouselContainer, [], imageOptions()); // the track is already in the page: wire it up, do not rebuild it
    } else if (Array.isArray(gallery)) {
      renderCarousel(carouselContainer, gallery.map((g) => ({ key: g.key, altText: g.alt })), imageOptions());
    }
  } catch (e) { /* malformed attribute: keep the static first photo */ }

  function readEmbeddedPageData() {
    try {
      const el = document.getElementById("page-data");
      const data = el ? JSON.parse(el.textContent) : null;
      return data && data.product ? data : null;
    } catch (e) { return null; }
  }

  function applyPageData(data) {
    pricing.product = data.product;
    pricing.packageOptions = data.product.packageOptions || [];
    pricing.discountTiers = data.discountTiers || [];
    pricing.maxOrderQuantity = data.maxOrderQuantity;
    pricing.packageId = pricing.packageOptions[0]?.id ?? null;
    paymentRules = parsePaymentRules(data.paymentRules);

    renderPackageSelector(packageSelect, packageField, pricing.packageOptions);
    rerenderPricing();

    // A published page already drew its gallery and testimonials. Only a page without them builds them from data.
    if (!carouselContainer?.dataset.gallery && !carouselContainer?.querySelector(".carousel")) {
      renderCarousel(carouselContainer, (data.images || []).map((img) => ({ key: img.r2Key, altText: img.altText })), imageOptions());
    }
    if (testimonialsContainer && !testimonialsContainer.querySelector(".testimonial-card")) {
      renderTestimonials(testimonialsContainer, (data.testimonials || []).map((t) => ({ url: mediaUrl(t.r2Key), ...t })));
    }
    hydrateDeliveryDates(data.deliveryOptions);
    restoreDraft();
    refreshPaymentOptions();
  }

  async function loadPageDataFromApi() {
    try {
      applyPageData(await getPageData(slug));
    } catch (err) {
      // No backend: the page's static content stays as it is.
      if (quantityPriceEl) quantityPriceEl.innerHTML = "";
    }
  }

  // Scheduled at the end of init (after every handler below is defined).
  const startPageData = () => {
    const embedded = readEmbeddedPageData();
    if (embedded) {
      try { applyPageData(embedded); } catch (err) { if (quantityPriceEl) quantityPriceEl.innerHTML = ""; }
      return;
    }
    if ("requestIdleCallback" in window) window.requestIdleCallback(loadPageDataFromApi); else setTimeout(loadPageDataFromApi, 1);
  };

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

  // ---- Validation: take the customer to what needs fixing ------------------------
  /**
   * After a refused submit, scroll to the FIRST field that needs attention (page order, so a blank form lands on the
   * first field and a nearly complete one lands on the one thing left) and put the cursor in it. Lightweight on purpose:
   * one querySelector, one scroll, one focus; smooth only when the device allows motion. The focus uses preventScroll so
   * the browser's own scroll (e.g. when the keyboard opens) does not fight ours.
   */
  const INVALID_NOTE = "Please check the highlighted field.";
  function focusFirstInvalid() {
    const field = form.querySelector('.field[data-invalid="true"]');
    if (!field) return;
    const control = field.querySelector("input:not([type=hidden]), select, textarea");
    const calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try { field.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" }); } catch (e) { field.scrollIntoView(); }
    if (control) { try { control.focus({ preventScroll: true }); } catch (e) { control.focus(); } }
  }

  // A field's red mark goes as soon as the customer starts correcting it, not only at the next submit.
  const unmark = (event) => {
    const field = event.target && event.target.closest ? event.target.closest(".field") : null;
    if (field && field.dataset.invalid === "true") setFieldError(field, "");
    if (statusEl.textContent === INVALID_NOTE && !form.querySelector('.field[data-invalid="true"]')) statusEl.textContent = "";
  };
  form.addEventListener("input", unmark);
  form.addEventListener("change", unmark);

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
    if (!valid) {
      statusEl.textContent = INVALID_NOTE;
      focusFirstInvalid();
      return;
    }

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
        focusFirstInvalid();
        return;
      }
    }

    submitButton.disabled = true;
    submitButton.dataset.loading = "true";
    retryBanner.dataset.visible = "false";
    statusEl.textContent = "Placing your order...";
    // This tap now owns the order: a token that arrives while it waits is picked up by it, not by the late-finish listener.
    busy = true;
    cancelLate?.();
    cancelLate = null;

    // The bot check never decides whether an order is sent. A token that is already there (the normal case) goes with
    // the order; a check that is already running is waited for briefly; otherwise the order goes without it and is
    // recorded. The page then runs the check and completes the SAME order (same key) when it arrives.
    const idempotencyKey = getOrCreateIdempotencyKey();
    const payload = collectOrderPayload(form, productId);
    payload.turnstileToken = await tokenForSubmit(1500);
    lastAttemptPayload = payload;

    await submitWithRetry(payload, idempotencyKey, { statusEl, retryBanner, submitButton });
  });

  manualRetryButton.addEventListener("click", async () => {
    if (!lastAttemptPayload) return;
    manualRetryButton.disabled = true;
    retryBanner.dataset.visible = "false";
    submitButton.disabled = true;
    submitButton.dataset.loading = "true";
    busy = true;
    cancelLate?.();
    cancelLate = null;
    await submitWithRetry(lastAttemptPayload, getOrCreateIdempotencyKey(), { statusEl, retryBanner, submitButton });
    manualRetryButton.disabled = false;
  });

  let busy = false; // a submit is in flight: a late token must not start a second one beside it
  let cancelLate = null;

  // Message for a customer whose order is safely recorded. It never says anything about the verification itself.
  const RECEIVED = "Thanks! We've received your order. Just finishing up\u2026";
  const CONFIRMED = "Thanks! We have your order and will confirm on WhatsApp shortly.";

  /** The order is recorded and nothing more is needed: leave for the thank-you page. */
  function finishOrder(result) {
    clearIdempotencyKey();
    // The order exists: the draft of the same details must not come back on the next visit and fill a second order.
    clearTimeout(draftTimer);
    clearDraft(slug);
    // Rest the page BEFORE leaving it (see restForm): the browser snapshots the document for the Back button.
    restForm();
    // The thank-you page shows this verbatim - it is the server's breakdown, never recomputed in the browser.
    try { sessionStorage.setItem("skincare_last_order", JSON.stringify(result)); } catch (e) { /* thank-you falls back */ }
    window.location.href = "/thank-you.html";
  }

  /** Sends the SAME order again with the token now in the form so the server completes it. The order already exists, so
   *  a failure here changes nothing for the customer. Returns once it has been answered or given up on. */
  async function completeWithToken(payload, idempotencyKey) {
    payload.turnstileToken = form.elements["turnstileToken"]?.value || "";
    if (!payload.turnstileToken) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await createOrder(payload, idempotencyKey); return; } catch (err) {
        if (err.status && err.status !== 429 && err.status !== 503) return;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
  }

  /**
   * Called once the server has recorded the order. If a token went with it (or there is no bot check in this build) the
   * order is complete. If not, the customer is told the order was received, the check is started (the box appears under
   * the button only if Cloudflare needs a tap, with a hint), and the SAME order is completed when the token arrives.
   * Whatever happens, they are never asked to submit again and a second order is never created.
   */
  async function onOrderRecorded(result, payload, idempotencyKey, ui) {
    if (payload.turnstileToken || !checkConfigured()) return finishOrder(result);

    clearTimeout(draftTimer);
    clearDraft(slug); // recorded: the draft has done its job
    ui.submitButton.disabled = true; // no accidental second tap while this order is being completed
    ui.submitButton.dataset.loading = "false";
    ui.statusEl.textContent = RECEIVED;

    if (await waitForToken(15000)) {
      await completeWithToken(payload, idempotencyKey);
      return finishOrder(result);
    }

    // The check did not finish in time (slow link, blocked script). The order IS recorded, so say so, leave the form ready
    // for the next order, and keep trying quietly: if the token turns up later it completes this order in place.
    checkFailed();
    clearIdempotencyKey();
    restForm();
    ui.statusEl.textContent = CONFIRMED;
    finishWhenCheckArrives(payload, idempotencyKey);
  }

  function finishWhenCheckArrives(payload, idempotencyKey) {
    cancelLate?.();
    cancelLate = onNextToken(async () => {
      cancelLate = null;
      if (busy) return; // a new order is being placed meanwhile: it needs this token
      await completeWithToken(payload, idempotencyKey);
      resetTurnstile(); // that token is spent; have a fresh one ready for the next order
    });
  }

  async function submitWithRetry(payload, idempotencyKey, ui) {
    cancelLate?.();
    cancelLate = null;
    busy = true;
    try {
      await runSubmit(payload, idempotencyKey, ui);
    } finally {
      busy = false;
    }
  }

  async function runSubmit(payload, idempotencyKey, ui) {
    let lastErr = null; // why the last attempt failed, so the final message is the true one
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await createOrder(payload, idempotencyKey);
        await onOrderRecorded(result, payload, idempotencyKey, ui);
        return;
      } catch (err) {
        lastErr = err;
        // 429 and 503 are the server asking for a retry (rate limit; verifier or database briefly unavailable).
        if (err.status && err.status !== 429 && err.status !== 503) {
          if (payload.turnstileToken) resetTurnstile();
          // A real validation/business error - retrying won't help. The attempt is over, so the key goes too: the next
          // submit is a new intent. The customer's input is untouched.
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
          focusFirstInvalid(); // the server named a field: take the customer to it too
          return;
        }
        if (attempt < 2) {
          ui.statusEl.textContent = "Still trying...";
          await new Promise((resolve) => setTimeout(resolve, [800, 1600, 3200][attempt]));
        }
      }
    }
    // Idempotency makes retries safe, but we still don't hammer a dead connection forever. NOTHING was recorded, so the
    // customer's input stays exactly as it is and the same key is kept for the next try.
    ui.statusEl.textContent = lastErr?.status
      ? `${lastErr.message}${lastErr.detail ? ` (${lastErr.detail})` : ""}`
      : lastErr ? `Could not send (${lastErr.name}).` : "";
    ui.retryBanner.dataset.visible = "true";
    ui.submitButton.disabled = false;
    ui.submitButton.dataset.loading = "false";
  }

  startPageData();
} catch (e) {}
}

// Images live in object storage; IMAGE_DELIVERY_BASE (injected at build time)
// is the public origin or path in front of it. A value that is already an
// absolute http(s) URL is used as-is, which is how a database row can point at
// a real CDN asset instead of a storage key.
function imageOptions() {
  return { mode: window.IMAGE_MODE || "transform", deliveryBase: window.IMAGE_DELIVERY_BASE || "/media" };
}

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
