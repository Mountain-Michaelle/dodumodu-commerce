// Order evidence badges in the admin console.
//
//   npm run build && node test/admin-evidence-ui.check.mjs
//
// The properties worth pinning are the ones that would make an operator MISLEAD a
// customer: a repeat buyer must not look suspicious, an ordinary order must carry
// no badge at all, and a duplicate must never be asserted as certain.
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
function ok(label, condition, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail && !condition ? `\n        ${detail}` : ""}`);
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://admin.example.com" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "CustomEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
Object.defineProperty(globalThis, "CSS", {
  value: dom.window.CSS ?? { escape: (s) => String(s).replace(/["\\]/g, "\\$&") },
  configurable: true, writable: true,
});
globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

const { orderBadges, orderEvidenceSection } = await import(`file://${siteRoot}shared/scripts/admin/views/evidence.js`);

/* ---- badges on a list row ---- */

ok("an ordinary order shows NO badges",
  orderBadges({}).innerHTML.trim() === "", `got: ${orderBadges({}).innerHTML}`);

ok("a first-time customer shows no badges",
  orderBadges({ spamFlagged: false, reordering: false, possibleDuplicate: false }).textContent === "");

ok("a reordering customer is labelled",
  /Reordering customer/.test(orderBadges({ reordering: true }).textContent));

ok("a repeat customer is styled POSITIVE, not as a warning",
  /badge-repeat/.test(orderBadges({ reordering: true }).innerHTML),
  "a returning buyer must not look like a problem");

ok("a possible duplicate says POSSIBLE, never 'Duplicate' alone",
  /Possible duplicate/.test(orderBadges({ possibleDuplicate: true, duplicateOf: { reference: "ord-1" } }).textContent));

ok("a duplicate badge names the matching order",
  /ord-1/.test(orderBadges({ possibleDuplicate: true, duplicateOf: { reference: "ord-1" } }).innerHTML));

ok("a spam flag keeps its existing label",
  /Spam flagged/.test(orderBadges({ spamFlagged: true }).textContent));

ok("badges coexist on one row",
  orderBadges({ spamFlagged: true, reordering: true, possibleDuplicate: true }).querySelectorAll(".badge").length === 3,
  `got ${orderBadges({ spamFlagged: true, reordering: true, possibleDuplicate: true }).querySelectorAll(".badge").length}`);

/* ---- the detail panel ---- */

ok("no evidence means no panel at all",
  orderEvidenceSection({ evidence: { previousOrders: 0, phoneKnown: true } }) === null);

const repeat = orderEvidenceSection({
  evidence: { phoneKnown: true, reordering: true, previousOrders: 4, previousSuccessful: 3,
    lastOrderReference: "ord-99", lastOrderAt: new Date("2026-02-01T10:00:00Z") },
});
const repeatHtml = repeat.outerHTML;
ok("repeat panel shows previous orders", />4</.test(repeatHtml));
ok("repeat panel shows previous SUCCESSFUL orders", /3/.test(repeatHtml));
ok("repeat panel shows the last order", /ord-99/.test(repeatHtml));

const dup = orderEvidenceSection({
  evidence: { phoneKnown: true, previousOrders: 0,
    duplicateOf: { id: 123, reference: "ord-77", createdAt: new Date("2026-02-01T10:00:00Z") } },
});
const dupHtml = dup.outerHTML;
ok("duplicate panel names the related order", /ord-77/.test(dupHtml));
ok("duplicate panel says nothing was changed automatically",
  /Nothing has been changed automatically/.test(dupHtml));
ok("duplicate panel states quantity is part of the match", /product and quantity/.test(dupHtml),
  "an order of a different quantity is a different order, and the panel must say so");
ok("duplicate panel never claims a device fingerprint", !/fingerprint/i.test(dupHtml),
  "no browser or device fingerprint exists in this system");
ok("duplicate panel offers inconclusive wording",
  /accidental double submission/.test(dupHtml));

const abuse = orderEvidenceSection({
  evidence: { phoneKnown: true, previousOrders: 0 },
  abuse: { ipMasked: "203.0.113.x", posts: 30, distinctPhones: 12, failures: 8, successfulProgressions: 4 },
});
const abuseHtml = abuse.outerHTML;
ok("abuse panel masks the address", /203\.0\.113\.x/.test(abuseHtml));
ok("abuse panel shows successful orders as counter-evidence", /Successful orders/.test(abuseHtml));
ok("abuse panel says an address is not an accusation",
  /shared by many customers/.test(abuseHtml));
ok("abuse panel states blocking is off", /switched off/.test(abuseHtml));

const unknown = orderEvidenceSection({
  evidence: { phoneKnown: false, previousOrders: 0, reordering: false },
});
ok("an unrecognised number says no history is claimed",
  /no customer history is claimed/.test(unknown.outerHTML),
  unknown.outerHTML.slice(0, 200));

ok("a missing evidence payload does not throw",
  orderEvidenceSection({ evidence: undefined, abuse: null, spamFlag: null }) === null);

console.log(failures === 0 ? "\nAll evidence-UI checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);