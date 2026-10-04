// The spam-moderation UI: a permanent exclusion of a real person must never be one
// click, and must never be visible before an operator opens the order.
//
//   npm run build && node test/admin-spam-ui.check.mjs
//
// The XSS property of the panel is already covered by admin-ui.check.mjs; this file
// covers the workflow rules, which are about what an operator CAN do rather than
// about what a customer can inject.
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));

let failures = 0;
function ok(label, condition, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail && !condition ? `\n        ${detail}` : ""}`);
}

const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", { url: "https://admin.example.com" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "CustomEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
Object.defineProperty(globalThis, "CSS", {
  value: dom.window.CSS ?? { escape: (s) => String(s).replace(/["\\]/g, "\\$&") },
  configurable: true, writable: true,
});

// Every API call is recorded rather than performed.
const posted = [];
globalThis.fetch = async (url, init) => {
  if (init && init.method === "POST") posted.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ flag: { id: 1 } }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

const { adminTable } = await import("../shared/scripts/admin/ui.js");
const spam = await import(`file://${siteRoot}shared/scripts/admin/views/spam.js`);

/* ---- the reason rule, mirrored from the server ---- */

const { spamFlagSection } = spam;

ok("spamFlagSection returns null when there is no flag",
  spamFlagSection(null, () => {}) === null,
  "an unflagged order must show no spam section at all");

/* ---- the panel shows the audit trail, and offers a revert ---- */

const flag = {
  id: 7,
  phoneMasked: "+234*******78",
  reason: "Repeated fake orders using different phone numbers",
  flaggedBy: "owner@example.com",
  flaggedAt: new Date("2026-02-07T13:20:00Z"),
};
const panel = spamFlagSection(flag, () => {});
const html = panel.outerHTML;
ok("panel shows Active status", /Active/.test(html));
ok("panel shows the reason", html.includes("Repeated fake orders"));
ok("panel shows who flagged it", html.includes("owner@example.com"));
ok("panel offers a revert", /Revert spam flag/.test(html));
ok("panel states the order itself is unaffected",
  /status, payment and delivery are unchanged/.test(html),
  "the operator must not think flagging cancels the order");
ok("panel masks the phone", html.includes("+234*******78"));

/* ---- the reason guard, through the real modal ---- */

const openModalFor = async (invoke) => {
  // Abandon any dialog a previous case left behind. Each case opens a NEW modal,
  // and querySelector returns the FIRST match - so without this, a later case would
  // assert against an earlier case's abandoned dialog and quietly test nothing.
  for (const stale of document.querySelectorAll(".overlay")) stale.remove();
  const promise = invoke();
  // The dialog is appended synchronously; give the promise a tick to settle.
  await new Promise((r) => setTimeout(r, 0));
  return { promise, dialog: document.querySelector(".dialog") };
};

// Empty reason: Confirm stays disabled.
{
  const { dialog } = await openModalFor(() => spam.markAsSpam({ id: 1, phone: "08012345678" }));
  const confirm = [...dialog.querySelectorAll("button")].find((b) => /mark as spam/i.test(b.textContent));
  ok("Confirm is disabled with an empty reason", confirm.disabled === true);
  ok("empty reason explains itself", /required/i.test(dialog.textContent));
}

// Contentless reason ("spam") is refused client-side too, mirroring the server.
{
  const { dialog } = await openModalFor(() => spam.markAsSpam({ id: 1, phone: "08012345678" }));
  const textarea = dialog.querySelector("textarea");
  const confirm = [...dialog.querySelectorAll("button")].find((b) => /mark as spam/i.test(b.textContent));
  textarea.value = "spam";
  textarea.dispatchEvent(new dom.window.Event("input"));
  ok("a contentless reason keeps Confirm disabled", confirm.disabled === true);
  ok("and says why", /does not explain/i.test(dialog.textContent));
}

// Too short.
{
  const { dialog } = await openModalFor(() => spam.markAsSpam({ id: 1, phone: "08012345678" }));
  const textarea = dialog.querySelector("textarea");
  const confirm = [...dialog.querySelectorAll("button")].find((b) => /mark as spam/i.test(b.textContent));
  textarea.value = "no";
  textarea.dispatchEvent(new dom.window.Event("input"));
  ok("a too-short reason keeps Confirm disabled", confirm.disabled === true);
}

// A real reason enables Confirm and is what gets sent.
{
  // Earlier modal cases opened dialogs but never submitted, so nothing should be in
  // `posted` yet. Assert that explicitly rather than assuming it.
  ok("nothing was sent before Confirm", posted.length === 0, JSON.stringify(posted));
  const { promise, dialog } = await openModalFor(() => spam.markAsSpam({ id: 42, phone: "08012345678" }));
  const textarea = dialog.querySelector("textarea");
  const confirm = [...dialog.querySelectorAll("button")].find((b) => /mark as spam/i.test(b.textContent));
  textarea.value = "  Repeated fake orders using different phone numbers  ";
  textarea.dispatchEvent(new dom.window.Event("input"));
  ok("a meaningful reason enables Confirm", confirm.disabled === false);
  confirm.click();
  // Toast schedules a timeout, which would otherwise keep the process alive
  // long after every assertion has run. Race the POST instead of awaiting it bare.
  await Promise.race([promise, new Promise((r) => setTimeout(r, 50))]);
  ok("the order id and cleaned reason are sent", posted.length === 1
    && posted[0].body.orderId === 42
    && posted[0].body.reason === "Repeated fake orders using different phone numbers",
  JSON.stringify(posted));
}

// Escape closes without sending anything.
{
  const before = posted.length;
  const { promise, dialog } = await openModalFor(() => spam.markAsSpam({ id: 9, phone: "08012345678" }));
  dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const result = await promise;
  ok("Escape closes without flagging", result === false && posted.length === before);
}

/* ---- the list tint is a boolean, never the reason ---- */

const rows = [
  { id: 1, reference: "a", spamFlagged: true },
  { id: 2, reference: "b", spamFlagged: false },
];
const table = adminTable({ columns: [{ label: "Ref", render: ({ row }) => row.reference }], rows, rowKey: (r) => r.id, rowClass: (r) => (r.spamFlagged ? "is-flagged" : "") });
const flaggedRow = table.querySelector("tr.is-flagged");
ok("a flagged row is tinted", flaggedRow !== null);
// The table also renders a header row, so count only body rows.
const bodyRows = table.querySelectorAll("tbody tr");
ok("an unflagged row is not tinted", bodyRows.length === 2 && table.querySelectorAll("tbody tr.is-flagged").length === 1,
  `body rows=${bodyRows.length} tinted=${table.querySelectorAll("tbody tr.is-flagged").length}`);

console.log(failures === 0 ? "\nAll spam-UI checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
