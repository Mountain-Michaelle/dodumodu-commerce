/* sanitizeSummaryHtml had a bug worth keeping around as a test: its last step
   was "if any '<' is left, return an empty string", and the tags it had just
   decided to keep are themselves made of '<'. So every summary with a <strong>
   came back blank - an admin saved a paragraph and the page lost it, with a 200
   and no complaint. These pin the two things that have to stay true: the allowed
   tags survive as tags, and nothing that executes or reaches the network does. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderListFiltersSchema,
  productPageUpsertSchema,
  publishRequestSchema,
  sanitizeSummaryHtml,
  testimonialUpsertSchema,
} from "./adminSchema";

test("order list filters accept lifecycle action filters and reject unknown actions", () => {
  assert.equal(orderListFiltersSchema.safeParse({ status: "cancelled" }).success, true);
  assert.equal(orderListFiltersSchema.safeParse({ status: "not_picking" }).success, true);
  assert.equal(orderListFiltersSchema.safeParse({ action: "cancel" }).success, true);
  assert.equal(orderListFiltersSchema.safeParse({ action: "mark-not-picking" }).success, true);
  assert.equal(orderListFiltersSchema.safeParse({ action: "unknown-action" }).success, false);
});

test("an allowed tag survives as a tag", () => {
  assert.equal(sanitizeSummaryHtml("<strong>four weeks</strong>"), "<strong>four weeks</strong>");
  assert.equal(sanitizeSummaryHtml("<p>Night <em>repair</em>.</p>"), "Night <em>repair</em>.");
  assert.equal(sanitizeSummaryHtml("line one<br/>line two"), "line one<br>line two");
});

test("a surviving tag is rebuilt from its name, so attributes cannot ride through", () => {
  assert.equal(sanitizeSummaryHtml('<b onclick="steal(document.cookie)" style="x">bold</b>'), "<b>bold</b>");
});

test("a script loses its body, and the words around it stay", () => {
  assert.equal(sanitizeSummaryHtml("keep <script>alert(1)</script> this"), "keep  this");
  assert.equal(sanitizeSummaryHtml("<iframe src='https://evil.test'></iframe>"), "");
});

test("a link cannot survive as a link, but its words do", () => {
  assert.equal(sanitizeSummaryHtml('<a href="javascript:alert(1)">buy now</a>'), "buy now");
  assert.equal(sanitizeSummaryHtml('<img src=x onerror="alert(1)">'), "");
});

test("one stray bracket costs a fragment, not the paragraph", () => {
  const result = sanitizeSummaryHtml("Apply to <strong damp skin every night");
  assert.ok(result.includes("Apply to"), `copy was discarded: ${JSON.stringify(result)}`);
  assert.ok(!result.includes("<"), `a bracket survived: ${JSON.stringify(result)}`);
});

test("the summary is capped at what the renderer will hold", () => {
  assert.equal(sanitizeSummaryHtml("a".repeat(9000)).length, 4000);
});

test("a partial page save leaves the absent columns alone", () => {
  const parsed = productPageUpsertSchema.parse({ ctaText: "Order now" });
  assert.equal(parsed.ctaText, "Order now");
  assert.equal(parsed.summaryHtml, undefined);
  assert.equal(parsed.benefits, undefined);
});

test("a benefit without a title is not a benefit", () => {
  assert.equal(productPageUpsertSchema.safeParse({ benefits: [{ body: "no title" }] }).success, false);
});

test("a WhatsApp screenshot needs an image; a written review does not", () => {
  const review = { title: "Works", description: "My spots faded", kind: "review", r2Key: "" };
  assert.equal(testimonialUpsertSchema.safeParse(review).success, true);
  const screenshot = { title: "Screenshotted", description: "From her", kind: "whatsapp", r2Key: "" };
  assert.equal(testimonialUpsertSchema.safeParse(screenshot).success, false);
});

test("publishing takes no body", () => {
  assert.equal(publishRequestSchema.safeParse({}).success, true);
  assert.equal(publishRequestSchema.safeParse({ productId: 1 }).success, false);
});
