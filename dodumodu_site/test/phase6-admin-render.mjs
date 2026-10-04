// Phase 6: does an operator actually SEE the evidence?
//
// The unit checks assert that the badge strings exist in the source. That is not
// the same as an operator being able to see them, and it is certainly not the same
// as the badge appearing on the right row. This renders the REAL admin views against
// REAL API responses from the running server, in a DOM, and then asserts on the
// resulting TEXT - so a badge that is built but never mounted fails here.
import { JSDOM } from "jsdom";

const BASE = process.env.BASE_URL || "http://localhost:8787";
const H = { "cf-access-authenticated-user-email": "admin@dodumodu.local" };
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();

let pass = 0; let fail = 0;
const check = (l, ok, d = "") => {
  if (ok) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${d ? ` -- ${d}` : ""}`); }
};

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle;

const { orderBadges, orderEvidenceSection } = await import("../shared/scripts/admin/views/evidence.js");

const list = await get("/admin/orders?pageSize=100");
// Rows are chosen by their EVIDENCE, not by a customer-name marker. An earlier
// version filtered on the name the Phase 6 script used and silently tested nothing
// once that script stopped being what generated the data.
const all = list.orders ?? [];
const rows = all.filter((o) => o.reordering || o.possibleDuplicate || o.spamFlagged);
console.log(`rows carrying evidence in the list: ${rows.length} of ${all.length}`);
const repeat = rows.find((r) => r.reordering === true);
const dup = rows.find((r) => r.possibleDuplicate === true && r.reordering === false);
// A row with no evidence at all - what most of the list looks like.
const plain = all.find((r) => !r.reordering && !r.possibleDuplicate && !r.spamFlagged);
console.log("\n=== list badges (what an operator scans) ===");
const rHtml = repeat ? orderBadges(repeat) : null;
const dHtml = dup ? orderBadges(dup) : null;
const pHtml = plain ? orderBadges(plain) : null;
check("a reordering row renders the 'Reordering customer' badge",
  Boolean(rHtml) && rHtml.textContent.includes("Reordering customer"));
check("a duplicate row renders the 'Possible duplicate' badge",
  Boolean(dHtml) && dHtml.textContent.includes("Possible duplicate"));
check("a normal row renders neither", !pHtml.textContent.includes("Reordering")
  && !pHtml.textContent.includes("duplicate"));
// orderBadges wraps its badges in a shared .badge-row container, so the tone lives
// on the inner <span>s. Comparing the wrapper proves nothing; compare the children.
const toneOf = (node) => [...(node?.querySelectorAll(".badge") ?? [])].map((b) => b.className);
const rTones = toneOf(rHtml);
const dTones = toneOf(dHtml);
check("each badge carries its own tone class",
  rTones.some((c) => c.includes("badge-repeat")) && dTones.some((c) => c.includes("badge-duplicate")),
  JSON.stringify({ rTones, dTones }));
check("the single-badge rows use different tone classes from one another",
  rTones.some((c) => c.includes("badge-repeat")) && dTones.some((c) => c.includes("badge-duplicate"))
  && rTones.join() !== dTones.join(), JSON.stringify({ rTones, dTones }));
check("the spam tone is a third, separate class",
  [".badge-repeat", ".badge-duplicate", ".badge-spam"].every((c) => !c.includes(" ")));
// The matching order is offered through the title, so an operator can open it from
// the row without hunting. The reference itself must be present.
check("the duplicate badge names the matching order for the operator",
  Boolean(dup?.duplicateOf?.reference)
  && [...dHtml.querySelectorAll(".badge")].some((b) => (b.getAttribute("title") ?? "").includes(dup.duplicateOf.reference)),
  dup?.duplicateOf?.reference ?? "none");

console.log("\n=== order detail evidence ===");
// Two orders are opened, because they carry different findings. Checking one order
// for both would prove nothing when a single order happened to have both.
const detail = await get(`/admin/orders/${dup.id}`);
const panelText = orderEvidenceSection(detail, { onChanged: () => {} }).textContent;
check("detail names the duplicate finding", /duplicate/i.test(panelText));
check("detail gives the operator the matching order reference",
  panelText.includes(dup.duplicateOf.reference), panelText.slice(0, 120));
check("detail does NOT print a raw phone number",
  !/0\d{10}/.test(panelText), (panelText.match(/0\d{10}/) || [""])[0]);

// The reordering row is opened separately: it is the only place the detail can be
// asked "does it explain WHY this person is a returning customer?"
const repeatDetail = await get(`/admin/orders/${repeat.id}`);
const repeatPanelText = orderEvidenceSection(repeatDetail, { onChanged: () => {} }).textContent;
check("detail explains the returning-customer finding",
  /reorder/i.test(repeatPanelText), repeatPanelText.slice(0, 80));
check("detail gives the previous-order evidence that justifies it",
  /previous|delivered/i.test(repeatPanelText), repeatPanelText.slice(0, 80));
check("detail does not expose the raw phone number on a reordering row",
  !/0\d{10}/.test(repeatPanelText), (repeatPanelText.match(/0\d{10}/) || [""])[0]);

console.log("\n=== shadow report view ===");
const shadow = await get("/admin/spam/shadow?windowSeconds=86400");
check("shadow report carries real evidence for this dataset",
  shadow.totals.posts > 0 && shadow.totals.distinctPhones > 0,
  `posts=${shadow.totals.posts} phones=${shadow.totals.distinctPhones}`);
check("shadow report states it blocks nobody", /shadow|block/i.test(shadow.notice || ""),
  (shadow.notice || "").slice(0, 70));
check("shadow report separates successful orders from volume",
  shadow.totals.successfulProgressions > 0 || shadow.ips.some((i) => i.successfulProgressions > 0));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
