// Dependency-free form UX harness for the product page.
//
//   node test/form-ux.check.mjs
//
// Why this exists: `npm test` needs esbuild + jsdom, so it cannot run until
// `npm install` succeeds. This check uses only node built-ins: it greps the
// page's inline CSS, then runs the inline progressive-enhancement script
// against a stub DOM to prove the stepper, auto-grow, inline validation, the
// submit loading state and the data-enhanced hand-off to the bundle all work.
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const FILE = fileURLToPath(new URL("../products/glow-serum/index.html", import.meta.url));
const html = readFileSync(FILE, "utf8");

let failures = 0;
const ok = (label, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${extra ? "  -> " + extra : ""}`);
  if (!pass) failures++;
};

/* ---------- 1. static checks ---------- */
const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const opens = (style.match(/\{/g) || []).length;
const closes = (style.match(/\}/g) || []).length;
ok("inline CSS braces balanced", opens === closes, `${opens} { / ${closes} }`);

/* The page's <style> is GENERATED from shared/styles by build/bundle.mjs, so it
   is minified by esbuild rather than hand-formatted. Two spellings of the same
   selector are therefore not a defect: esbuild drops the quotes in
   [name="quantity"] and collapses ::before to :before. Assertions below are
   written against the source sheets' spelling and compared normalized, so this
   test states what the CSS means rather than how it was typed. */
const cssNorm = (value) => value.replace(/::/g, ":").replace(/["']/g, "").replace(/\s+/g, " ");
const normStyle = cssNorm(style);
const hasRule = (selector) => normStyle.includes(cssNorm(selector));

for (const sel of [
  ".quantity-stepper{", ".quantity-stepper-btn{", ".quantity-stepper-btn:disabled",
  '.quantity-stepper input[name="quantity"]{', ".price-breakdown{", ".price-breakdown:empty",
  '.submit-button[data-loading="true"]::after', ".field textarea{", '.field[data-invalid="true"]',
  ".radio-option:has(input:checked)", ".order-form{", ".field-error{",
  ".quantity-row{", ".quantity-price{", ".quantity-price:empty", ".quantity-price-badge{",
  '.quantity-price-tier[data-active="true"]',
]) {
  ok(`CSS has ${sel}`, hasRule(sel));
}

ok("textarea hides resize grabber", /\.field textarea\{[^}]*resize:none/.test(style));
ok("order-form centered + capped width", /\.order-form\{[^}]*max-width:520px[^}]*margin:0 auto/.test(style));

/* Row spacing: halved so the form reads as one block, while the validation
   line under every field keeps its reserved height (errors must not reflow). */
const inlineGap = (sel) => {
  const m = style.match(new RegExp(`\\${sel}\\{[^}]*gap:(\\d+)px`));
  return m ? Number(m[1]) : null;
};
ok("form rows sit half as far apart", inlineGap(".order-form") === 7, `gap:${inlineGap(".order-form")}px`);
ok("paired rows sit half as far apart", inlineGap(".field-row") === 7, `gap:${inlineGap(".field-row")}px`);
ok("payment options sit half as far apart", inlineGap(".radio-group") === 5, `gap:${inlineGap(".radio-group")}px`);
ok("validation line keeps its reserved space (unchanged)", /\.field-error\{[^}]*min-height:1em/.test(style));
ok("label-to-input gap untouched", inlineGap(".field") === 6, `gap:${inlineGap(".field")}px`);

/* Desktop grouping: paired rows + horizontal payment options, unchanged on mobile.
   The block is located by brace depth rather than by indentation, so this keeps
   working against the generated (minified, single-line) stylesheet. */
function mediaBlock(css, headerRe) {
  const header = css.match(headerRe);
  if (!header) return "";
  let depth = 0;
  for (let i = css.indexOf("{", header.index); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(header.index, i + 1);
  }
  return "";
}
const desktop = mediaBlock(style, /@media\s*\(min-width:\s*768px\)/);
ok("inline CSS has a 768px desktop block", Boolean(desktop));
ok("mobile: field rows are single column", /\.field-row\{[^}]*grid-template-columns:1fr(?:;|\})/.test(style));
ok("mobile: payment options stacked", /\.radio-group\{[^}]*grid-template-columns:1fr/.test(style) || /\.radio-group\{[^}]*gap:10px/.test(style));
ok("desktop: field rows become two columns", /\.field-row\{[^}]*1fr 1fr/.test(desktop));
ok("desktop: payment options become a horizontal group", /\.radio-group\{[^}]*1fr 1fr/.test(desktop));
ok("desktop: card widens to balance the two columns", /\.order-form\{[^}]*max-width:720px/.test(desktop));
ok("exactly two paired rows in the markup", (html.match(/<div class="field-row">/g) || []).length === 2, `${(html.match(/<div class="field-row">/g) || []).length} rows`);

/* Markup: the pairs the CSS expects must actually be wrapped. */
const rowMatches = [...html.matchAll(/<div class="field-row">([\s\S]*?)\n        <\/div>/g)].map((m) => m[1]);
const rowFields = rowMatches.map((chunk) => [...chunk.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]));
ok("phone + whatsapp wrapped in one row", rowFields.some((f) => f.join(",") === "phone,whatsapp"), JSON.stringify(rowFields[0] || []));
ok("state + delivery date wrapped in one row", rowFields.some((f) => f.join(",") === "state,deliveryDate"), JSON.stringify(rowFields[1] || []));
ok("name, address, quantity, notes stay single full-width fields", !rowFields.flat().includes("customerName") && !rowFields.flat().includes("address") && !rowFields.flat().includes("quantity"));
ok("wrapping did not move the late-warning out of the form", html.indexOf('id="late-warning"') > 0 && html.indexOf('id="late-warning"') < html.indexOf("</form>"));
ok("wrapping did not break the [data-field] contract count", (html.match(/data-field="/g) || []).length === 10, `${(html.match(/data-field="/g) || []).length} fields`);

/* Nesting safety: a mis-closed row wrapper would silently break the layout. */
const formRegion = html.slice(html.indexOf('id="order-form"'), html.indexOf("</form>"));
const openDivs = (formRegion.match(/<div\b/g) || []).length;
const closeDivs = (formRegion.match(/<\/div>/g) || []).length;
ok("form markup: div tags balanced", openDivs === closeDivs, `${openDivs} open / ${closeDivs} close`);
ok("form markup: fieldsets balanced", (formRegion.match(/<fieldset>/g) || []).length === (formRegion.match(/<\/fieldset>/g) || []).length);
ok("each row holds exactly two fields and no fieldset",
  rowFields.length === 2 && rowFields.every((f) => f.length === 2) && rowMatches.every((chunk) => !chunk.includes("<fieldset")));

/* Live price: the stepper and the price box must be one row, price after it. */
const quantityRow = html.match(/<div class="quantity-row">([\s\S]*?)\n          <\/div>/);
ok("quantity stepper + live price share one row", Boolean(quantityRow));
ok("price box sits after the stepper inside that row",
  Boolean(quantityRow) && /id="quantity-stepper"[\s\S]*id="quantity-price"/.test(quantityRow[1]));
ok("price box is a sibling of the stepper, not nested in it",
  Boolean(quantityRow) && /<div class="quantity-price" id="quantity-price"/.test(quantityRow[1]));
ok("price box is announced as a labelled group",
  /id="quantity-price"[^>]*role="group"[^>]*aria-label="[^"]+"/.test(html));
ok("desktop row gaps are halved too",
  /\.field-row\{[^}]*gap:9px/.test(desktop) && /\.radio-group\{[^}]*gap:6px/.test(desktop));

/* ---------- 2. extract inline script ---------- */
const jsMatch = html.match(/<script>\s*([\s\S]*?\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/);
ok("inline FORM UX script found", Boolean(jsMatch));
const code = jsMatch[1];

/* The live-price block reads its unit price off the page's own JSON-LD offer,
   so the stub gets that real block rather than a hand-written copy — if the
   markup loses its price, these checks fail instead of silently passing. */
const ldJson = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);

/* ---------- 3. stub DOM ---------- */
function makeEl(tag, attrs = {}) {
  const listeners = {};
  const el = {
    tagName: tag,
    dataset: { ...(attrs.dataset || {}) },
    style: {},
    value: attrs.value ?? "",
    max: attrs.max ?? "",
    disabled: attrs.disabled ?? false,
    scrollHeight: attrs.scrollHeight ?? 0,
    _text: "",
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, extra = {}) {
      const event = { type, target: el, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
      (listeners[type] || []).slice().forEach((fn) => fn(event));
      return event;
    },
    querySelector(sel) { return (attrs.els || {})[sel] || null; },
    querySelectorAll(sel) { return (attrs.lists || {})[sel] || []; },
    closest(sel) { return attrs.closest === sel ? el : null; },
    focus() { el.focused = true; },
    scrollIntoView() { el.scrolledIntoView = true; },
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; },
  };
  return el;
}

const fieldDefs = ["customerName", "phone", "whatsapp", "address", "state", "deliveryDate", "quantity", "questionNotes", "paymentMethod"];
const fields = fieldDefs.map((name) => {
  const box = makeEl("div", { dataset: { for: name } });
  const field = makeEl("div", { dataset: { field: name }, els: { ".field-error": box } });
  field.box = box;
  return field;
});

const inputs = {};
for (const name of fieldDefs) inputs[name] = makeEl("input", { value: name === "quantity" ? "1" : "" });

const quantityInput = inputs.quantity;
const minusBtn = makeEl("button", { dataset: { action: "decrement" }, closest: ".quantity-stepper-btn" });
const plusBtn = makeEl("button", { dataset: { action: "increment" }, closest: ".quantity-stepper-btn" });
const stepper = makeEl("div", {
  els: {
    'input[name="quantity"]': quantityInput,
    '.quantity-stepper-btn[data-action="decrement"]': minusBtn,
    '.quantity-stepper-btn[data-action="increment"]': plusBtn,
  },
  closest: ".quantity-stepper-btn",
});

const textareaA = makeEl("textarea", { scrollHeight: 120 });
const textareaB = makeEl("textarea", { scrollHeight: 60 });
const priceBox = makeEl("div");
const ldEl = makeEl("script");
ldEl.textContent = JSON.stringify(ldJson);
const statusEl = makeEl("div");
const submitBtn = makeEl("button");

const form = makeEl("form", {
  els: { ".form-status": statusEl, ".submit-button": submitBtn },
  lists: { ".field": fields, textarea: [textareaA, textareaB] },
});
form.elements = inputs;

const documentStub = {
  getElementById: (id) => (id === "order-form" ? form
    : id === "quantity-stepper" ? stepper
      : id === "quantity-price" ? priceBox
        : null),
  querySelector: (sel) => (sel === 'input[name="quantity"]' ? quantityInput
    : sel === 'script[type="application/ld+json"]' ? ldEl
      : null),
};
const timers = [];
new Function("document", "setTimeout", code)(documentStub, (fn) => timers.push(fn));

/* ---------- 4. behaviour tests ---------- */
ok("minus disabled at quantity 1", minusBtn.disabled === true);
stepper.dispatch("click", { target: plusBtn });
ok("+ increments to 2", quantityInput.value === 2 && minusBtn.disabled === false, `value=${quantityInput.value}`);

for (let i = 0; i < 40; i++) stepper.dispatch("click", { target: plusBtn });
ok("+ clamps at default max 20", quantityInput.value === 20 && plusBtn.disabled === true, `value=${quantityInput.value}`);

stepper.dispatch("click", { target: minusBtn });
ok("- decrements to 19", quantityInput.value === 19 && plusBtn.disabled === false, `value=${quantityInput.value}`);

for (let i = 0; i < 40; i++) stepper.dispatch("click", { target: minusBtn });
ok("- clamps at 1", quantityInput.value === 1 && minusBtn.disabled === true, `value=${quantityInput.value}`);

stepper.dispatch("click", { target: plusBtn });
stepper.dispatch("click", { target: plusBtn });
stepper.dispatch("click", { target: minusBtn });
ok("+/- round trip back to 2", quantityInput.value === 2, `value=${quantityInput.value}`);
ok("max attribute declared in HTML", /id="quantity-input"[^>]*min="1" max="20"/.test(html));

quantityInput.value = "abc";
quantityInput.dispatch("blur");
ok("blur snaps invalid input back to 1", quantityInput.value === 1, `value=${quantityInput.value}`);

/* ---------- 4b. live price beside the quantity ---------- */

/* Tiers the preview block ships with (read out of the script we just ran) and
   the same expected numbers derived independently from the page's JSON-LD. */
const previewTiers = [...code.matchAll(/\{ minQuantity: (\d+), discountPercent: (\d+), label: (null|'[^']*') \}/g)]
  .map((m) => ({
    minQuantity: Number(m[1]),
    discountPercent: Number(m[2]),
    label: m[3] === "null" ? null : m[3].slice(1, -1),
  }));
ok("inline preview tiers parsed", previewTiers.length === 4, `${previewTiers.length} tiers`);

const productOffer = ldJson["@graph"].find((n) => n["@type"] === "Product").offers;
const unitPriceKobo = Math.round(Number(productOffer.price) * 100);
ok("preview unit price comes from the page's JSON-LD offer", unitPriceKobo > 0, `${unitPriceKobo} kobo`);

const nairaText = (kobo) => `₦${Math.round(kobo / 100).toLocaleString("en-NG")}`;
const expectedAt = (quantity) => {
  const tier = previewTiers
    .filter((t) => t.minQuantity <= quantity)
    .sort((a, b) => b.minQuantity - a.minQuantity)[0];
  const subtotal = unitPriceKobo * quantity;
  const percent = tier ? tier.discountPercent : 0;
  const saved = Math.round((subtotal * percent) / 100);
  return { percent, saved, total: nairaText(subtotal - saved) };
};
const shownTotal = () => (String(priceBox.innerHTML).match(/quantity-price-total">([^<]+)</) || [])[1] || null;
const activeLabel = () => (String(priceBox.innerHTML).match(/data-active="true"[\s\S]*?<span>([^<]+)<\/span>/) || [])[1] || null;
const activeCount = () => (String(priceBox.innerHTML).match(/data-active="true"/g) || []).length;
const tierCount = () => (String(priceBox.innerHTML).match(/quantity-price-tier"/g) || []).length;
const setQuantity = (value) => { quantityInput.value = value; quantityInput.dispatch("input"); };

ok("live price renders next to the stepper on load",
  priceBox.innerHTML.includes("quantity-price-total") && priceBox.innerHTML.includes("quantity-price-each"));

ok("quantity 1: no discount badge, plain unit price", !priceBox.innerHTML.includes("quantity-price-badge")
  && shownTotal() === expectedAt(1).total, `${shownTotal()} vs ${expectedAt(1).total}`);

setQuantity("2");
ok("quantity 2: total drops as the 10% tier applies",
  shownTotal() === expectedAt(2).total, `${shownTotal()} vs ${expectedAt(2).total}`);
ok("quantity 2: badge labels the discount and the amount saved",
  priceBox.innerHTML.includes(`${expectedAt(2).percent}% off`) && priceBox.innerHTML.includes(`save ${nairaText(expectedAt(2).saved)}`));
ok("every discount is listed and labelled", tierCount() === 3
  && priceBox.innerHTML.includes("Every discount")
  && previewTiers.every((t) => !t.label || priceBox.innerHTML.includes(t.label)), `${tierCount()} tiers`);
ok("exactly the reached tier is marked active",
  activeCount() === 1 && activeLabel() === "Buy 2, save 10%", `${activeLabel()} (${activeCount()} active)`);

setQuantity("3");
ok("quantity 3: total follows into the 20% tier",
  shownTotal() === expectedAt(3).total && activeLabel() === "Buy 3 or 4, save 20%",
  `${shownTotal()} vs ${expectedAt(3).total} / ${activeLabel()}`);

setQuantity("5");
ok("quantity 5: total follows into the 25% tier",
  shownTotal() === expectedAt(5).total && activeLabel() === "Buy 5+, save 25%",
  `${shownTotal()} vs ${expectedAt(5).total} / ${activeLabel()}`);
ok("quantity 5: saving scales with the tier", priceBox.innerHTML.includes(`save ${nairaText(expectedAt(5).saved)}`));

setQuantity("1");
ok("stepping back down re-prices without a badge",
  !priceBox.innerHTML.includes("quantity-price-badge") && shownTotal() === expectedAt(1).total);

quantityInput.value = "";
quantityInput.dispatch("blur");
ok("a cleared quantity prices as 1, not as NaN", shownTotal() === expectedAt(1).total, `${shownTotal()}`);


/* The auto-grow floor must match the CSS min-height, so read it from the CSS
   rather than hardcoding it — the two can never drift apart. It is read from
   .field textarea because that is the rule shared/styles actually ships (it
   is what styles every control inside a .field); a miss reports through the
   assertion below instead of crashing the run. */
const textareaFloor = Number(style.match(/\.field textarea\{[^}]*min-height:(\d+)px/)?.[1] ?? 0);
ok("textarea auto-grow floor matches CSS min-height",
  textareaA.style.height === "120px" && textareaB.style.height === `${textareaFloor}px`,
  `${textareaA.style.height} / ${textareaB.style.height} (css floor ${textareaFloor}px)`);

let ev = form.dispatch("submit");
ok("empty submit is prevented", ev.prevented === true);
ok("empty submit focuses first invalid field", inputs.customerName.focused === true);
ok("empty submit sets [data-invalid]", fields[0].dataset.invalid === "true" && fields[2].dataset.invalid === "true");
ok("empty submit prints status", statusEl.textContent === "Please correct the highlighted fields.", statusEl.textContent);
ok("empty submit does NOT load the button", submitBtn.dataset.loading === undefined && submitBtn.disabled === false);

inputs.customerName.value = "Chioma Adeyemi";
inputs.phone.value = "08012345678";
inputs.whatsapp.value = "08012345678";
inputs.address.value = "12 Allen Avenue, Ikeja, near First Bank";
inputs.state.value = "Lagos";
inputs.deliveryDate.value = "tomorrow";
inputs.quantity.value = "3";

ev = form.dispatch("submit");
ok("valid submit clears previous errors", fields[0].dataset.invalid === "false" && fields[0].box.textContent === "");
ok("valid submit shows loading on button", submitBtn.dataset.loading === "true" && submitBtn.disabled === true);
ok("valid submit prints progress status", statusEl.textContent === "Placing your order...", statusEl.textContent);

timers.splice(0).forEach((fn) => fn());
ok("loading state clears after preview timeout", submitBtn.dataset.loading === "false" && submitBtn.disabled === false);

/* hand-off: bundled app owns stepper + form + the live price */
stepper.dataset.enhanced = "true";
form.dataset.enhanced = "true";
priceBox.innerHTML = "bundled-app-output";
const before = quantityInput.value;
stepper.dispatch("click", { target: plusBtn });
ok("no double increment once bundled app owns stepper", quantityInput.value === before, `value=${quantityInput.value}`);
quantityInput.value = "4";
quantityInput.dispatch("input");
ok("live price stands down once the bundled app owns the page",
  priceBox.innerHTML === "bundled-app-output", String(priceBox.innerHTML));
ev = form.dispatch("submit");
ok("no double submit once bundled app owns form", ev.prevented === false);

/* ---------- 5. shared CSS parity (built page must match the inline preview) ---------- */
const formCss = readFileSync(new URL("../shared/styles/form.css", import.meta.url), "utf8");
const pricingCss = readFileSync(new URL("../shared/styles/pricing.css", import.meta.url), "utf8");

ok("shared form.css: centered capped form", /\.order-form \{[\s\S]*?max-width: 520px[\s\S]*?margin: 0 auto/.test(formCss));
ok("shared form.css: label above field", /\.field \{[\s\S]*?flex-direction: column/.test(formCss));
ok("shared form.css: no resize grabber", /\.field textarea \{[\s\S]*?resize: none/.test(formCss));
ok("shared form.css: submit spinner", formCss.includes('.submit-button[data-loading="true"]::after'));
ok("shared form.css: error state", formCss.includes('.field[data-invalid="true"] input'));
ok("shared form.css: has field-row group", /\.field-row \{[\s\S]*?grid-template-columns: 1fr;/.test(formCss));
ok("shared form.css: desktop rows go 2-col with the wider card",
  /@media \(min-width: 768px\) \{[\s\S]*?max-width: 720px[\s\S]*?\.field-row \{ grid-template-columns: 1fr 1fr/.test(formCss));
ok("shared form.css: payment group goes horizontal on desktop", /@media \(min-width: 768px\) \{[\s\S]*?\.radio-group \{ grid-template-columns: 1fr 1fr/.test(formCss));
ok("shared form.css: textarea floor matches the inline preview", formCss.includes(`min-height: ${textareaFloor}px`));
ok("shared pricing.css: seamless stepper group", /\.quantity-stepper \{[\s\S]*?inline-flex[\s\S]*?overflow: hidden/.test(pricingCss));
ok("shared pricing.css: 46px tap targets", pricingCss.includes("flex: 0 0 46px"));
ok("shared pricing.css: empty breakdown hidden", pricingCss.includes(".price-breakdown:empty { display: none; }"));

/* Spacing parity: the built page must keep the same row rhythm as the preview. */
const sharedGaps = {
  form: Number(formCss.match(/\.order-form \{[\s\S]*?gap: (\d+)px/)[1]),
  row: Number(formCss.match(/\.field-row \{\s*display: grid;[\s\S]*?gap: (\d+)px/)[1]),
  radio: Number(formCss.match(/\.radio-group \{\s*display: grid;[\s\S]*?gap: (\d+)px/)[1]),
};
ok("shared form.css: row gaps match the inline preview",
  sharedGaps.form === inlineGap(".order-form") && sharedGaps.row === inlineGap(".field-row")
  && sharedGaps.radio === inlineGap(".radio-group"), JSON.stringify(sharedGaps));
ok("shared form.css: desktop row gaps halved too", formCss.includes("gap: 9px") && formCss.includes("gap: 6px"));
ok("shared form.css: validation line still reserves its space", formCss.includes("min-height: 1em"));

/* Shared pricing.css must carry the live-price card as well. */
ok("shared pricing.css: live price sits beside the stepper", /\.quantity-row \{[\s\S]*?flex-wrap: wrap/.test(pricingCss));
ok("shared pricing.css: live price hidden until it has data", pricingCss.includes(".quantity-price:empty { display: none; }"));
ok("shared pricing.css: active discount tier is marked", pricingCss.includes('.quantity-price-tier[data-active="true"]'));
ok("shared pricing.css: discount badge", /\.quantity-price-badge \{[\s\S]*?var\(--color-success\)/.test(pricingCss));

/* The preview tiers and the pricing smoke mock describe one shop, so they have
   to agree — drift here means the page promises discounts the API won't honour
   (or hides ones it would). */
const smokeSource = readFileSync(new URL("./pricing.smoke.mjs", import.meta.url), "utf8");
const smokeTiers = [...smokeSource.matchAll(/\{ minQuantity: (\d+), discountPercent: (\d+), label: (null|"[^"]*") \}/g)]
  .map((m) => ({
    minQuantity: Number(m[1]),
    discountPercent: Number(m[2]),
    label: m[3] === "null" ? null : m[3].slice(1, -1),
  }));
ok("preview tiers agree with the pricing smoke mock",
  JSON.stringify(previewTiers) === JSON.stringify(smokeTiers), `${previewTiers.length} vs ${smokeTiers.length}`);
const smokePrice = Number(smokeSource.match(/product: \{[^}]*price: (\d+)/)[1]);
ok("page price agrees with the pricing smoke mock unit price", unitPriceKobo === smokePrice, `${unitPriceKobo} vs ${smokePrice}`);

/* ---------- 6. bundled renderer parity, without needing a build ----------
   `npm test` runs the jsdom smoke test against dist/, but that needs esbuild +
   jsdom installed. This section imports the very modules the bundle is built
   from (render.js → pricing.js) and drives them with a two-line DOM stub, so
   the price shown beside the stepper is still checked against pricing.js's
   formula — the client-side mirror of the server's discountService. */
globalThis.document = {
  createElement: () => {
    let text = "";
    return {
      set textContent(value) { text = value; },
      get innerHTML() {
        return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      },
    };
  },
};
const { renderLivePrice, renderPriceBreakdown } = await import("../shared/scripts/render.js");
const { computePriceBreakdown, formatNaira } = await import("../shared/scripts/pricing.js");

for (const quantity of [1, 2, 3, 5, 20]) {
  const box = { innerHTML: "" };
  const breakdown = renderLivePrice(box, unitPriceKobo, quantity, previewTiers);
  const expected = computePriceBreakdown(unitPriceKobo, quantity, previewTiers);
  const shown = (box.innerHTML.match(/quantity-price-total">([^<]+)</) || [])[1];
  const badge = (box.innerHTML.match(/quantity-price-badge"[^>]*>\s*([^<]+?)\s*</) || [])[1];
  const marked = (box.innerHTML.match(/data-active="true"/g) || []).length;

  ok(`bundled renderer: qty ${quantity} total matches pricing.js`,
    breakdown.amount === expected.amount && shown === formatNaira(expected.amount), `${shown}`);

  if (expected.discountPercent > 0) {
    ok(`bundled renderer: qty ${quantity} badge names the ${expected.discountPercent}% and the saving`,
      Boolean(badge) && badge.startsWith(`${expected.discountPercent}% off`)
      && badge.includes(`save ${formatNaira(expected.discountAmount)}`), badge);
    ok(`bundled renderer: qty ${quantity} marks exactly one reached discount`, marked === 1);
  } else {
    ok(`bundled renderer: qty ${quantity} shows no discount badge`, badge === undefined);
  }
}

ok("bundled renderer: survives a page with no price box", renderLivePrice(null, unitPriceKobo, 3, previewTiers) === null);
const invoice = { innerHTML: "" };
renderPriceBreakdown(invoice, unitPriceKobo, 3, previewTiers);
ok("bundled renderer: itemised breakdown still renders",
  invoice.innerHTML.includes("Discount (20%)") && invoice.innerHTML.includes("Total"));

/* ---------- 7. COD gate, delivery dates, drafts, lazy Turnstile ----------
   These are pure logic modules shared by the bundle, so they can be driven
   directly with a stub window/document. Section 6 already replaced
   globalThis.document, so extend that stub rather than replacing it again. */
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
const scripts = [];
globalThis.document = {
  ...globalThis.document,
  getElementById: (id) => (id === "cf-turnstile" ? { dataset: {} } : null),
  querySelector: () => null,
  createElement: () => ({ dataset: {} }),
  head: { appendChild: (el) => scripts.push(el) },
};

const { decideCod, codHint, parsePaymentRules, normalizeState } = await import("../shared/scripts/codRules.js");
const RULES = { codStates: ["Lagos", "Ogun", "Enugu", "Abuja"], codBulkThreshold: 5 };

ok("COD: an eligible state under the ceiling is allowed", decideCod("Lagos", 4, RULES).allowed === true);
ok("COD: eligible state at the ceiling is refused for bulk", decideCod("Lagos", 5, RULES).reason === "bulk");
ok("COD: a state outside the list is refused for state, not quantity", decideCod("Kano", 1, RULES).reason === "state");
ok("COD: an out-of-list state outranks a bulk quantity", decideCod("Kano", 12, RULES).reason === "state");
ok("COD: 'Other' and an unanswered state are both refused",
  decideCod("Other", 1, RULES).allowed === false && decideCod("", 1, RULES).allowed === false);
ok("COD: case, padding, 'State' suffix and Abuja/FCT all resolve to one place",
  ["lagos", "  Lagos  ", "Lagos State", "LAGOS state"].every((s) => decideCod(s, 1, RULES).allowed)
  && normalizeState("Abuja") === normalizeState("FCT") && decideCod("FCT", 1, RULES).allowed === true);
ok("COD: a backend threshold change tightens or relaxes the browser one",
  decideCod("Lagos", 7, { ...RULES, codBulkThreshold: 10 }).allowed === true);
ok("COD: no rules at all means the server is the only voice", decideCod("Kano", 99, null).unknown === true);
ok("COD: a threshold of 0 (missing rules row) closes COD everywhere",
  decideCod("Lagos", 1, { codStates: [], codBulkThreshold: 0 }).allowed === false);
ok("COD: a garbage payload degrades to closed, never wide open",
  parsePaymentRules({ codStates: "Lagos", codBulkThreshold: "abc" }).codBulkThreshold === 0
  && parsePaymentRules(undefined) === null);
ok("COD: the hint never quotes a different ceiling than the refusal",
  codHint("Lagos", 1, RULES).includes("4") && decideCod("Lagos", 9, RULES).message.includes("up to 4"));
ok("COD: the state refusal names the state the customer actually picked",
  decideCod("Kano", 1, RULES).message.includes("Kano"));

/* The browser gate and the server gate must never drift: the customer is shown
   the browser's sentence and then refused with the server's, so the two files
   are compared against each other here rather than trusted. */
const backend = (p) => readFileSync(new URL(`../../dodumodu_backend/src/${p}`, import.meta.url), "utf8");
const policySource = backend("services/codPolicyService.ts");
const browserSource = readFileSync(new URL("../shared/scripts/codRules.js", import.meta.url), "utf8");
ok("server gate uses the same >= threshold comparison", /quantity >= rules\.codBulkThreshold/.test(policySource));
ok("server and browser both compute the ceiling as threshold - 1",
  policySource.includes("rules.codBulkThreshold - 1") && browserSource.includes("rules.codBulkThreshold - 1"));
for (const fragment of [
  "Pay on delivery isn't available in",
  "choose \"Pay now\" and we'll dispatch today",
  "Pay on delivery covers up to",
  "for bulk orders",
]) {
  ok(`server and browser share the wording "${fragment.slice(0, 34)}..."`,
    policySource.includes(fragment) && browserSource.includes(fragment));
}
ok("server gate is exported with the API-facing error type and a public shape",
  policySource.includes("CodNotAvailableError") && policySource.includes("publicRules"));

/* Delivery dates: the "Today" option that used to sit in the static markup all
   day. 14:59 vs 15:00 WAT (WAT = UTC+1 year-round, no DST). */
const { isPastCutoff, deliveryChoices, isDeliveryChoice } = await import("../shared/scripts/deliveryOptions.js");
const wat = (h, m = 0) => new Date(Date.UTC(2026, 8, 9, h - 1, m));
ok("delivery: 'today' is offered at 09:00 WAT", deliveryChoices(wat(9)).includes("today"));
ok("delivery: 'today' is withdrawn exactly at the 15:00 WAT cutoff",
  isPastCutoff(wat(14, 59)) === false && isPastCutoff(wat(15, 0)) === true);
ok("delivery: after the cutoff only tomorrow and the day after are offered",
  JSON.stringify(deliveryChoices(wat(21))) === JSON.stringify(["tomorrow", "next_tomorrow"]));
ok("delivery: a stale stored date is recognised as no longer orderable",
  isDeliveryChoice("today", wat(9)) === true && isDeliveryChoice("today", wat(21)) === false);
ok("delivery: the page no longer pre-selects today in the static markup",
  !/<option value="today" selected>/.test(html) && /<option value="" selected>Choose a delivery date<\/option>/.test(html));

/* Drafts: the four fields the customer would be furious to retype, and nothing
   that would make a stale promise. */
const { saveDraft, loadDraft, applyDraft, clearDraft } = await import("../shared/scripts/draftStore.js");
const draftForm = {
  elements: {
    customerName: { value: "Chioma Adeyemi" },
    phone: { value: "08012345678" },
    whatsapp: { value: "08012345678" },
    address: { value: "12 Allen Avenue, Ikeja" },
    state: { value: "Lagos" },
    deliveryDate: { value: "today" },
    quantity: { value: "7" },
    paymentMethod: { value: "cod" },
    questionNotes: { value: "call my sister" },
  },
};
saveDraft(draftForm, "glow-serum");
const stored = JSON.parse(store.get("skincare_order_draft:glow-serum"));
ok("draft: stores exactly the four identity fields plus a timestamp",
  Object.keys(stored).sort().join(",") === "address,customerName,phone,savedAt,whatsapp", Object.keys(stored).join(","));
ok("draft: never stores state, quantity, date, payment method or notes",
  !["state", "quantity", "deliveryDate", "paymentMethod", "questionNotes"].some((k) => k in stored));
const blankForm = { elements: { customerName: { value: "" }, phone: { value: "" }, whatsapp: { value: "" }, address: { value: "" } } };
ok("draft: a refresh restores what the customer typed",
  applyDraft(blankForm, loadDraft("glow-serum")) === 4 && blankForm.elements.customerName.value === "Chioma Adeyemi");
ok("draft: a field the customer already re-typed is not overwritten",
  applyDraft({ elements: { customerName: { value: "New Name" } } }, loadDraft("glow-serum")) === 0);
clearDraft("glow-serum");
ok("draft: cleared once the order is placed, so it never fills a second order", loadDraft("glow-serum") === null);
saveDraft(draftForm, "other-serum");
const crossPage = loadDraft("glow-serum");
clearDraft("other-serum");
ok("draft: one product's draft never reaches another product page", crossPage === null);

/* Turnstile: 100-200 KB of third-party JS that must not sit in the critical
   path on a poor connection. */
const { armTurnstile } = await import("../shared/scripts/turnstile.js");
globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
armTurnstile({ addEventListener() {} });
ok("turnstile: nothing is requested before the customer reaches the form", scripts.length === 0);
ok("turnstile: the page no longer hardcodes an eager challenges.cloudflare.com script",
  !/<script[^>]+src="[^"]*challenges\.cloudflare\.com/i.test(html));
ok("turnstile: the token callback bridges the page's global to the lazy loader",
  /window\.__turnstileTokenReceived/.test(html));
ok("turnstile: the widget stays hidden until it loads, so it cannot shift layout",
  hasRule(".cf-turnstile{display:none") && hasRule('.cf-turnstile[data-ready="true"]{display:block}'));

/* With no site key the widget is disabled, so ensureToken() resolves with nothing
   and the payload carries an empty token. That is CORRECT, and the server has to
   accept it: orderSchema.ts allows an empty token and verifyTurnstile is the only
   thing that decides whether one was needed. These pin the sending half of that
   contract, and are read the same way the COD gate above is - the two repos are
   compared against each other, because a blank token posted on purpose used to be
   a guaranteed 400 the customer could do nothing about. */
const orchestrateSource = readFileSync(new URL("../shared/scripts/orchestrate.js", import.meta.url), "utf8");
const orderSchemaSource = backend("validation/orderSchema.ts");
ok("turnstile: the payload always carries the field, empty included, so the server decides",
  /payload\.turnstileToken\s*=\s*form\.elements\[.turnstileToken.\]\?\.value\s*\|\|\s*""/.test(orchestrateSource));
ok("turnstile: orchestrate waits for a token instead of posting a blank one when configured",
  /await ensureToken\(\)/.test(orchestrateSource));
ok("turnstile: the server's shape check accepts the blank token this build sends",
  !/turnstileToken:\s*z\.string\(\)\.min\(1\)/.test(orderSchemaSource)
    && /turnstileToken:\s*z\.string\(\)/.test(orderSchemaSource));
ok("turnstile: the server keeps a real gate for the token, it is just not the schema's job",
  /verifyTurnstile\(/.test(backend("routes/orders.ts")));

/* Copy must not promise pay on delivery where the gate now refuses it. */
ok("copy: nothing on the page still claims pay on delivery is nationwide",
  !/nationwide/i.test(html) && !/available across Nigeria/i.test(html));
ok("copy: the FAQ answer names the same states the gate uses",
  /Lagos, Ogun, Enugu and Abuja/.test(html));
ok("copy: the meta description names the COD states",
  /Pay on delivery in Lagos, Ogun, Enugu/.test(html));
ok("copy: the state dropdown offers Enugu and an unselected placeholder",
  /<option>Enugu<\/option>/.test(html) && /<option value="">Select your state<\/option>/.test(html));
ok("perf: the hero ships a 320w candidate so small phones skip the 640w file",
  /seed\/glow-serum-hero\/320\/320 320w/.test(html) && /sizes="\(max-width: 480px\) 92vw, 480px"/.test(html));
ok("perf: the preload declares the same srcset, so no image is downloaded twice",
  /imagesrcset="[^"]*320\/320 320w/.test(html));

/* The order form has to come back empty after an order is placed. The order is
   confirmed and the page then navigates, so the only moment the reset can happen
   is between the 200 and the navigation — and the browser caches the document as
   it unloads, so a reset that runs after the navigation never happens at all.
   These pin the ordering, because a reset in the wrong place looks identical in
   the happy path and only shows up on the customer's Back button. The
   behavioural counterpart is test/order-success.smoke.mjs; these are the cheap
   ones that run without a build. */
const successBlock = orchestrateSource.slice(orchestrateSource.indexOf("const result = await createOrder"));
ok("order-success: the form is reset before the page navigates, not after",
  /restForm\(\);\s*[\s\S]*?window\.location\.href/.test(successBlock));
ok("order-success: the reset clears the draft, not just the inputs",
  /clearDraft\(slug\)/.test(successBlock));
ok("order-success: loading is turned off, so the spinner cannot outlive the order",
  /submitButton\.dataset\.loading\s*=\s*"false"/.test(
    orchestrateSource.slice(orchestrateSource.indexOf("function restForm"))));
ok("order-success: the module-side price state is reset too, not only the DOM",
  /pricing\.quantity\s*=\s*1/.test(
    orchestrateSource.slice(orchestrateSource.indexOf("function restForm"))));
ok("order-success: a back/forward-cache restore drops the spent Turnstile token",
  /pageshow/.test(orchestrateSource) && /resetTurnstile/.test(orchestrateSource));
// Scoped to submitWithRetry's own catch: an earlier `catch (err)` belongs to the
// page-data loader and sits before restForm is even defined, so searching the
// whole file from the first catch would match the definition, not a call.
const retryFn = orchestrateSource.slice(orchestrateSource.indexOf("async function submitWithRetry"));
ok("order-success: a failed order is not reset, so the customer keeps their details",
  !/restForm/.test(retryFn.slice(retryFn.indexOf("} catch (err)"))));

/* The reference is generated in one repo and read off the page in the other, and
   the webhook has to find it again whatever case the payment provider echoes. */
const orderServiceSource = backend("services/orderService.ts");
ok("reference: the server writes it in lowercase",
  /return `ord-\$\{/.test(orderServiceSource) && !/toUpperCase\(\)/.test(orderServiceSource));
ok("reference: the webhook's lookup folds case, or paid orders are never marked paid",
  /lower\(\$\{orders\.reference\}\)\s*=\s*lower\(\$\{reference\}\)/.test(backend("data/ordersRepo.ts")));
const thankYou = readFileSync(new URL("../thank-you.html", import.meta.url), "utf8");
ok("thank-you: there is a real link back to the order page",
  /<a class="back-link" href="\/products\/glow-serum\/">/.test(thankYou));
ok("thank-you: the customer is told the company will be in touch",
  /call or WhatsApp you on the number you gave us/i.test(thankYou));
ok("thank-you: the reference is shown lowercase in its own code style",
  /\.confirm-reference\{[^}]*monospace/.test(thankYou)
    && /toLowerCase\(\)/.test(thankYou));
ok("thank-you: it never claims payment succeeded on its own",
  /status === "confirmed_cod"/.test(thankYou));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
