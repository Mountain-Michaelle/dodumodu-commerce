import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

/* What happens to the order form once the order exists.
 *
   The business asked for three things after a successful upload: the spinner
   stops, the form is empty and ready for a new order, and going Back (or using
   the thank-you link) does not resurrect a placed order. All three are decided
   in the same instant — between the 200 and the navigation — so they are tested
   as one behaviour rather than three.

   The failure case is asserted with equal weight, because the obvious way to
   write the reset is to call it in the wrong place, and an order that failed
   with the customer's details wiped is a lost sale and a support call. */

const DIST = new URL("../dist/", import.meta.url);

const MOCK_PAGE_DATA = {
  product: { id: 1, slug: "glow-serum", name: "Radiance Glow Serum", price: 1500000, packageOptions: [] },
  images: [{ r2Key: "img1.jpg", altText: "Bottle" }],
  testimonials: [{ r2Key: "t1.jpg", title: "Amaka", description: "Loved it" }],
  deliveryOptions: ["tomorrow", "next_tomorrow"],
  paymentRules: { codStates: ["Lagos", "Ogun", "Enugu", "Abuja"], codBulkThreshold: 5 },
  discountTiers: [
    { minQuantity: 1, discountPercent: 0, label: null },
    { minQuantity: 2, discountPercent: 10, label: "Buy 2, save 10%" },
    { minQuantity: 3, discountPercent: 20, label: "Buy 3 or 4, save 20%" },
    { minQuantity: 5, discountPercent: 25, label: "Buy 5+, save 25%" },
  ],
  maxOrderQuantity: 20,
};

const UNIT_PRICE_NAIRA = 15000; // ₦15,000, from the price above (which is in kobo)

const CONFIRMED_COD = {
  reference: "ord-mfkk2r8-4b1c9ad2",
  status: "confirmed_cod",
  unitPrice: 1500000,
  quantity: 3,
  subtotal: 4500000,
  discountPercent: 20,
  discountAmount: 900000,
  amount: 3600000,
};

const DRAFT_KEY = "skincare_order_draft:glow-serum";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * jsdom cannot follow a real navigation, and the navigation is the thing under
 * test — we are asserting on the state the page is left in, not on where it
 * went. Every other jsdom error still goes to the console.
 */
function makeConsole() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (/Not implemented: navigation/.test(error.message)) return;
    console.error(error);
  });
  return virtualConsole;
}

/** Boots the built product page against a stubbed API; the response decides success or failure. */
async function bootProductPage(createOrderResponse) {
  const html = readFileSync(new URL("products/glow-serum/index.html", DIST), "utf8");
  const jsBundle = readFileSync(new URL(html.match(/site\.[a-f0-9]+\.min\.js/)[0], DIST), "utf8");

  const dom = new JSDOM(html, {
    url: "https://yoursite.com/products/glow-serum/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: makeConsole(),
  });
  const { window } = dom;
  if (!window.crypto?.randomUUID) {
    window.crypto = Object.assign(window.crypto ?? {}, { randomUUID: () => "test-uuid-0000" });
  }

  const posted = [];
  window.fetch = async (url, options) => {
    if (String(url).includes("/page-data/")) return { ok: true, json: async () => MOCK_PAGE_DATA };
    if (String(url).includes("/create-order")) {
      posted.push(JSON.parse(options.body));
      return createOrderResponse;
    }
    throw new Error(`Unexpected fetch in smoke test: ${url}`);
  };
  window.requestIdleCallback = (fn) => fn();

  window.eval(jsBundle);
  await sleep(60); // page-data fetch, then the first render

  return { window, doc: window.document, posted };
}

function setField(doc, name, value) {
  const el = doc.querySelector(`[name='${name}']`);
  el.value = value;
  el.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
}

function fillForm(doc, quantity) {
  setField(doc, "customerName", "Chioma Adeyemi");
  setField(doc, "phone", "08012345678");
  setField(doc, "whatsapp", "08012345678");
  setField(doc, "address", "12 Allen Avenue, Ikeja");
  setField(doc, "state", "Lagos");
  setField(doc, "deliveryDate", "tomorrow");
  setField(doc, "paymentMethod", "cod");
  if (quantity) setField(doc, "quantity", String(quantity));
}

function submitForm(doc) {
  doc.getElementById("order-form")
    .dispatchEvent(new doc.defaultView.Event("submit", { bubbles: true, cancelable: true }));
}

function readTotal(doc) {
  const row = [...doc.querySelectorAll("#price-breakdown .price-breakdown-row")]
    .find((r) => r.textContent.includes("Total"));
  return row.querySelector("span:last-child").textContent;
}

const naira = (amount) => `₦${amount.toLocaleString("en-NG")}`;

/* ---------- 1. A successful order leaves the form ready for the next one ---- */
{
  const { window, doc, posted } = await bootProductPage(
    { ok: true, status: 200, json: async () => CONFIRMED_COD },
  );

  const submitButton = doc.querySelector(".submit-button");
  fillForm(doc, 3);
  // Draft writes are debounced, so let one land before submitting — otherwise
  // "the draft was cleared" would pass for the wrong reason.
  await sleep(500);
  assert.ok(window.localStorage.getItem(DRAFT_KEY), "a draft exists before the order is placed");
  assert.equal(readTotal(doc), naira(36000), "sanity: 3 units, 20% off");

  submitForm(doc);
  await sleep(150);

  assert.equal(posted.length, 1, "the order was submitted once");
  assert.equal(posted[0].quantity, 3, "the order carried the quantity the customer chose");

  // 1. Loading has stopped — the visible "spinner never stops" symptom.
  assert.equal(submitButton.dataset.loading, "false", "the spinner is not left running");
  assert.equal(submitButton.disabled, false, "the button is live again, not stuck disabled");
  assert.equal(doc.getElementById("retry-banner").dataset.visible, "false");
  assert.equal(doc.querySelector(".form-status").textContent, "", "no stale status text");

  // 2. The form is empty and ready for new entry.
  for (const name of ["customerName", "phone", "whatsapp", "address", "state", "deliveryDate", "questionNotes"]) {
    assert.equal(doc.querySelector(`[name='${name}']`).value, "", `${name} is cleared for the next customer`);
  }
  assert.equal(doc.querySelector("[name='quantity']").value, "1", "quantity is back to 1");

  // 3. The price agrees with the form. form.reset() cannot reach `pricing`, which
  //    is module state — without an explicit reset the stepper reads 1 next to a
  //    total still priced for the order just placed.
  assert.equal(readTotal(doc), naira(UNIT_PRICE_NAIRA), "the breakdown is priced at one unit again");

  // 4. Nothing is left that would re-fill this order on the way back.
  assert.equal(window.localStorage.getItem(DRAFT_KEY), null, "the draft is gone");
  assert.equal(window.sessionStorage.getItem("skincare_order_idempotency_key"), null, "the idempotency key is gone");
  const handoff = JSON.parse(window.sessionStorage.getItem("skincare_last_order"));
  assert.equal(handoff.reference, CONFIRMED_COD.reference, "thank-you is handed the server's own reference");
  console.log("PASS: a placed order leaves an empty form, no spinner, and a one-unit price");
}


/* ---------- 2. A failed order keeps the customer's details ----------------- */
{
  const { window, doc } = await bootProductPage({
    ok: false,
    status: 400,
    json: async () => ({
      error: "We could not place that order.",
      fields: { address: ["That address is too short"] },
    }),
  });

  const submitButton = doc.querySelector(".submit-button");
  fillForm(doc);
  await sleep(500);
  assert.ok(window.localStorage.getItem(DRAFT_KEY), "a draft exists before the failed attempt");

  submitForm(doc);
  await sleep(150);

  assert.equal(submitButton.dataset.loading, "false", "the spinner stops on failure too");
  assert.equal(submitButton.disabled, false, "the customer can correct and resubmit");
  assert.equal(doc.querySelector("[name='customerName']").value, "Chioma Adeyemi", "the name survives a failure");
  assert.equal(doc.querySelector("[name='address']").value, "12 Allen Avenue, Ikeja", "the address survives");
  assert.ok(
    window.localStorage.getItem(DRAFT_KEY),
    "a refused order must not cost the customer their half-finished form",
  );
  assert.match(doc.querySelector(".form-status").textContent, /could not place/i, "the failure is explained");
  const addressField = doc.querySelector("[data-field='address']");
  assert.equal(addressField.dataset.invalid, "true", "the field the server named is marked invalid");
  assert.match(
    addressField.textContent,
    /That address is too short/,
    "the server's message is shown against the field it names",
  );
  console.log("PASS: a refused order keeps every field, the draft and the explanation");
}


/* ---------- 3. The thank-you page says the useful things ------------------- */
{
  const html = readFileSync(new URL("thank-you.html", DIST), "utf8");
  const dom = new JSDOM(html, {
    url: "https://yoursite.com/thank-you.html",
    runScripts: "dangerously",
    virtualConsole: makeConsole(),
    // Runs before the document is parsed, so the page's own inline script finds
    // the order already there — exactly how the page is reached in a browser.
    beforeParse(window) {
      window.sessionStorage.setItem("skincare_last_order", JSON.stringify(CONFIRMED_COD));
    },
  });
  const doc = dom.window.document;

  // A way back, as a real link. history.back() would do nothing at all on a
  // refreshed or shared thank-you page, and guarantees nothing about the form.
  const back = doc.querySelector("a.back-link");
  assert.ok(back, "the thank-you page offers a way back");
  assert.equal(back.getAttribute("href"), "/products/glow-serum/", "it goes to the order page");
  assert.ok(back.textContent.trim().length > 0, "the control is labelled, not a bare arrow");

  // Informational: what kind of order this is, and what happens next.
  const message = doc.getElementById("confirm-message").textContent;
  assert.match(message, /pay[- ]on[- ]delivery/i, "the message says what kind of order this is");
  assert.ok(message.length > 60, `the message actually explains the order: ${message}`);
  assert.match(doc.getElementById("confirm-status").textContent, /call you/i, "it says the team will call");
  assert.match(doc.body.textContent, /What happens next/i, "there is a 'what happens next' section");

  // The reassurance the business asked for: someone is going to get in touch.
  assert.match(
    doc.querySelector(".confirm-next").textContent,
    /call or WhatsApp you on the number you gave us/i,
    "the customer is told, in words, that the company will be in touch",
  );

  // The reference, in the lowercase monospace form the business asked for.
  const reference = doc.querySelector(".confirm-reference");
  assert.ok(reference, "the reference is rendered in its own code style");
  assert.equal(reference.textContent, CONFIRMED_COD.reference);
  assert.equal(reference.textContent, reference.textContent.toLowerCase(), "the reference is lowercase");
  assert.ok(
    /^ord-[a-z0-9]+-[a-z0-9]{8}$/.test(reference.textContent),
    "and shaped the way the order service writes it",
  );
  console.log("PASS: thank-you offers a way back, explains next steps, and shows a lowercase reference");
}

console.log("\nAll order-success + thank-you smoke tests passed.");

