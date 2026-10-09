import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../dist/products/glow-serum/index.html", import.meta.url), "utf8");
const jsBundle = readFileSync(
  new URL(`../dist/${html.match(/site\.[a-f0-9]+\.min\.js/)[0]}`, import.meta.url),
  "utf8",
);

const MOCK_PAGE_DATA = {
  product: { id: 1, slug: "glow-serum", name: "Radiance Glow Serum", price: 1500000, packageOptions: [] },
  images: [{ r2Key: "img1.jpg", altText: "Bottle" }],
  testimonials: [{ r2Key: "t1.jpg", title: "Amaka", description: "Loved it" }],
  deliveryOptions: ["today", "tomorrow", "next_tomorrow"],
  // What the API publishes: the storefront renders these and never decides for
  // itself, so a change here is a change to the live site with no redeploy.
  paymentRules: { codStates: ["Lagos", "Ogun", "Enugu", "Abuja"], codBulkThreshold: 5 },
  discountTiers: [
    { minQuantity: 1, discountPercent: 0, label: null },
    { minQuantity: 2, discountPercent: 10, label: "Buy 2, save 10%" },
    { minQuantity: 3, discountPercent: 20, label: "Buy 3 or 4, save 20%" },
    { minQuantity: 5, discountPercent: 25, label: "Buy 5+, save 25%" },
  ],
  maxOrderQuantity: 20,
};

const dom = new JSDOM(html, {
  url: "https://yoursite.com/products/glow-serum/",
  runScripts: "dangerously",
  // Deliberately NOT `resources: "usable"`: the bundle below is eval'd from
  // disk, and letting jsdom also fetch it (and the picsum hero) over the
  // network makes the test slow and dependent on someone else's uptime.
  pretendToBeVisual: true,
});

const { window } = dom;
window.fetch = async (url) => {
  if (String(url).includes("/page-data/")) {
    return { ok: true, json: async () => MOCK_PAGE_DATA };
  }
  throw new Error(`Unexpected fetch in smoke test: ${url}`);
};
window.requestIdleCallback = (fn) => fn();

// The bundle is a plain IIFE built for a browser <script> tag — eval it in
// the jsdom window context, same as loading it via <script src>.
window.eval(jsBundle);

// Let the async page-data fetch + render pass resolve.
await new Promise((resolve) => setTimeout(resolve, 50));

const doc = window.document;
const priceBreakdown = doc.getElementById("price-breakdown");
const quantityInput = doc.querySelector("input[name='quantity']");
const plusBtn = doc.querySelector(".quantity-stepper-btn[data-action='increment']");

function readTotal() {
  const totalRow = [...priceBreakdown.querySelectorAll(".price-breakdown-row")]
    .find((row) => row.textContent.includes("Total"));
  return totalRow.querySelector("span:last-child").textContent;
}

// The price the customer watches beside the stepper (rendered by
// renderLivePrice from the same API tiers the server will charge).
const livePrice = doc.getElementById("quantity-price");
const liveTotal = () => livePrice.querySelector(".quantity-price-total").textContent;

function discountServiceFormula(unitPrice, quantity, tiers) {
  const subtotal = unitPrice * quantity;
  const applicable = tiers.filter((t) => t.minQuantity <= quantity).sort((a, b) => b.minQuantity - a.minQuantity);
  const percent = applicable[0]?.discountPercent ?? 0;
  const discountAmount = Math.round((subtotal * percent) / 100);
  return subtotal - discountAmount;
}

function nairaOf(kobo) {
  return `₦${Math.round(kobo / 100).toLocaleString("en-NG")}`;
}

// 1 unit: no discount line should appear.
assert.equal(quantityInput.value, "1", "quantity starts at 1");
assert.ok(!priceBreakdown.innerHTML.includes("Discount"), "no discount line at quantity 1");
assert.equal(readTotal(), nairaOf(discountServiceFormula(1500000, 1, MOCK_PAGE_DATA.discountTiers)));
assert.ok(livePrice.innerHTML.includes("quantity-price-each"), "live price renders beside the stepper");
assert.ok(!livePrice.innerHTML.includes("quantity-price-badge"), "no discount badge at quantity 1");
assert.equal(liveTotal(), nairaOf(discountServiceFormula(1500000, 1, MOCK_PAGE_DATA.discountTiers)));
console.log("PASS: quantity 1, no discount, total matches backend formula");

// Increment to 3 — should hit the 20% tier and match discountService's formula exactly.
plusBtn.click();
plusBtn.click();
assert.equal(quantityInput.value, "3");
assert.ok(priceBreakdown.innerHTML.includes("Discount (20%)"), "20% discount line shown at quantity 3");
assert.equal(readTotal(), nairaOf(discountServiceFormula(1500000, 3, MOCK_PAGE_DATA.discountTiers)));
assert.equal(liveTotal(), nairaOf(discountServiceFormula(1500000, 3, MOCK_PAGE_DATA.discountTiers)), "live total tracks the 20% tier");
assert.ok(livePrice.innerHTML.includes("20% off") && livePrice.innerHTML.includes(`save ${nairaOf(900000)}`),
  "live badge labels the discount and the exact saving");
assert.ok(livePrice.innerHTML.includes('data-active="true" aria-current="true"><span>Buy 3 or 4, save 20%</span>'),
  "the reached tier is marked with the admin's own label");
assert.equal((livePrice.innerHTML.match(/quantity-price-tier"/g) || []).length, 3, "every configured discount is listed");
assert.ok(MOCK_PAGE_DATA.discountTiers.every((t) => !t.label || livePrice.innerHTML.includes(t.label)),
  "every discount label from the API is shown next to the quantity");
console.log("PASS: quantity 3, 20% discount, total matches backend formula");

// Increment to 4 — still 20% (tier covers the range), boundary check.
plusBtn.click();
assert.equal(quantityInput.value, "4");
assert.ok(priceBreakdown.innerHTML.includes("Discount (20%)"), "still 20% at quantity 4");
console.log("PASS: quantity 4 still 20% (tier range boundary correct)");

// Increment to 5 — crosses into 25%.
plusBtn.click();
assert.equal(quantityInput.value, "5");
assert.ok(priceBreakdown.innerHTML.includes("Discount (25%)"), "25% discount line shown at quantity 5");
assert.equal(readTotal(), nairaOf(discountServiceFormula(1500000, 5, MOCK_PAGE_DATA.discountTiers)));
assert.equal(liveTotal(), nairaOf(discountServiceFormula(1500000, 5, MOCK_PAGE_DATA.discountTiers)), "live total tracks the 25% tier");
assert.ok(livePrice.innerHTML.includes('aria-current="true"><span>Buy 5+, save 25%</span>'),
  "the live ladder moves the active mark to the 25% tier");
console.log("PASS: quantity 5, 25% discount, total matches backend formula");

// Max quantity ceiling: + button disables at maxOrderQuantity.
for (let i = 0; i < 20; i++) plusBtn.click();
assert.equal(quantityInput.value, "20");
assert.equal(plusBtn.disabled, true, "+ disables at maxOrderQuantity");
console.log("PASS: quantity clamps at maxOrderQuantity and + disables");

/* ---- Pay-on-delivery gate, driven through the real page ------------------
   The state and quantity the customer picks must decide, without a round trip,
   whether "Pay on delivery" is offered at all — and the wording shown must be
   the wording the API would refuse with (codPolicyService.ts). */
const stateSelect = doc.querySelector("select[name='state']");
const codRadio = doc.querySelector("input[name='paymentMethod'][value='cod']");
const payNowRadio = doc.querySelector("input[name='paymentMethod'][value='pay_now']");
const codHint = doc.getElementById("cod-hint");
const codOption = doc.querySelector("[data-pay-option='cod']");

const setQuantity = (n) => {
  quantityInput.value = String(n);
  quantityInput.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const setState = (value) => {
  stateSelect.value = value;
  stateSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
};

// Back under the ceiling: Lagos, 4 items -> pay on delivery is a real choice.
setQuantity(4);
setState("Lagos");
assert.equal(codRadio.disabled, false, "COD is offered in Lagos under the ceiling");
assert.equal(codOption.dataset.unavailable, "false");
assert.ok(codHint.textContent.includes("4"), `hint names the ceiling: ${codHint.textContent}`);
console.log("PASS: COD offered in Lagos at quantity 4, hint names the ceiling");

// Same state, at the ceiling: the customer picked COD, so it must be moved off
// it rather than left as a checked-but-disabled radio that submits itself.
codRadio.checked = true;
setQuantity(5);
assert.equal(codRadio.disabled, true, "COD is withdrawn at the bulk ceiling");
assert.equal(codOption.dataset.unavailable, "true");
assert.equal(payNowRadio.checked, true, "a checked COD radio is moved back to pay now");
assert.ok(/bulk/i.test(codHint.textContent), `bulk reason is explained: ${codHint.textContent}`);
console.log("PASS: COD withdrawn at quantity 5 and the selection corrected to pay now");

// A state outside the list, back under the ceiling: refused for the state, not
// the quantity, and the message names the state the customer actually chose.
setQuantity(1);
setState("Kano");
assert.equal(codRadio.disabled, true, "COD is withdrawn outside the eligible states");
assert.ok(codHint.textContent.includes("Kano"), `state refusal names the state: ${codHint.textContent}`);
assert.ok(!/bulk/i.test(codHint.textContent), "does not blame a quantity the customer could change");
console.log("PASS: COD withdrawn in Kano, message names the state not the quantity");

// "Other" can never be an eligible state.
setState("Other");
assert.equal(codRadio.disabled, true, "the 'Other' bucket is never eligible for COD");
console.log("PASS: COD withdrawn for the 'Other' state bucket");

// Going back to an eligible state re-opens the option — the gate is not a
// one-way door, and a customer who corrects their state is not left stuck.
setState("Enugu");
assert.equal(codRadio.disabled, false, "COD is offered again in an eligible state");
assert.equal(codOption.dataset.unavailable, "false");
assert.ok(/available in your area/.test(codHint.textContent),
  `the refusal is replaced by the positive hint: ${codHint.textContent}`);
console.log("PASS: COD re-enabled after switching back to an eligible state");

/* ---- Delivery dates: "Today" must not survive the 15:00 WAT cutoff ---------
   The static markup once shipped <option value="today" selected>, so a customer
   opening the page at 9pm was offered same-day delivery the server would never
   honour. The page may only remove an option, never invent one. */
const deliverySelect = doc.querySelector("select[name='deliveryDate']");
const offered = () => [...deliverySelect.options].map((o) => o.value).filter(Boolean);
assert.equal(deliverySelect.value, "", "no date is pre-selected for the customer");
assert.ok(offered().length > 0, "the date list was populated from page-data");
console.log(`PASS: delivery dates rendered from page-data (${offered().join(", ")}), nothing pre-selected`);

console.log("\nAll frontend pricing + payment-gate smoke tests passed.");
