// Proves the admin console cannot be made to execute what a customer typed.
//
//   npm run build && node test/admin-ui.check.mjs
//
// Why this file exists: the panel that shipped before this rewrite built its order
// rows with innerHTML and a template literal, interpolating customerName, phone and
// address straight into the markup. An order placed with the name
// `<img src=x onerror=...>` therefore ran script inside the admin console - the one
// place somebody with access to every customer's details is looking. The rewrite
// fixes that by never assigning a value as HTML, and this test is what keeps it
// fixed: it drives the real modules in jsdom and asserts that hostile values land
// as TEXT.
//
// It also pins the two behaviours that are easy to regress and expensive to notice
// late: the row action menu follows the SERVER's action list rather than a table
// compiled into the browser, and no backend secret is present in the shipped bundle.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const distDir = join(siteRoot, "dist");

let failures = 0;
function ok(label, condition, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail && !condition ? `\n        ${detail}` : ""}`);
}

/** Asserts a string matches a pattern, showing the value that failed. */
function assertMatch(value, pattern) {
  ok(`matches ${pattern}`, pattern.test(value), `got: ${value}`);
}

/* ---- a DOM the modules can run against ---- */

const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", {
  url: "http://localhost:8787/admin/",
  pretendToBeVisual: true,
});

// The modules read `window` for API_BASE and touch document directly, so they are
// evaluated with the jsdom globals in scope rather than imported into Node.
//
// navigator is defined with a getter only, so it cannot simply be assigned. It is
// already a real Navigator in Node 22 and `window` is what the modules read, so
// redefining it is unnecessary - which is the better outcome, since replacing a
// real global with a stub is how a test ends up passing for the wrong reason.
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true, writable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true, writable: true });
Object.defineProperty(globalThis, "Node", { value: dom.window.Node, configurable: true, writable: true });
Object.defineProperty(globalThis, "CSS", {
  value: dom.window.CSS ?? { escape: (s) => String(s).replace(/["\\]/g, "\\$&") },
  configurable: true,
  writable: true,
});

const { el, mount } = await import("../shared/scripts/admin/dom.js");
const { statusBadge, actionMenu, adminTable, resultCount } = await import("../shared/scripts/admin/ui.js");
const { buildXlsx, crc32 } = await import("../shared/scripts/admin/xlsx.js");

/* ---- the security property ---- */

// A name a customer can genuinely type into the checkout form.
const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';

const node = el("div", { class: "stack" },
  el("span", { class: "strong", text: HOSTILE }),
  el("span", { text: `12 Allen Avenue, Ikeja & Sons "Ltd"` }));

ok("a hostile customer name is inserted as text, not parsed as markup",
  node.querySelector("img") === null, "an <img> element was created from the value");
ok("the hostile name survives verbatim as the element's text",
  node.textContent.includes(HOSTILE), `got: ${node.textContent}`);
ok("no script from the value can run",
  dom.window.__pwned === undefined);

ok("an ampersand and quotes in an address are not treated as entities",
  node.textContent.includes("& Sons \"Ltd\""));

// A value reaching the table must behave identically.
const table = adminTable({
  caption: "test",
  rows: [{ id: 1, reference: HOSTILE, customerName: HOSTILE }],
  columns: [
    { label: "Reference", render: ({ row }) => el("code", { text: row.reference }) },
    { label: "Customer", render: ({ row }) => el("span", { text: row.customerName }) },
  ],
});
ok("a hostile value in a table cell stays text",
  table.querySelector("img") === null && table.textContent.includes(HOSTILE));

/* ---- the row menu follows the server, not a browser-side rule table ---- */

const menu = actionMenu([
  { label: "Mark delivered", onSelect: () => {} },
  { label: "Mark paid (override)", danger: true, onSelect: () => {} },
]);
const items = [...menu.querySelectorAll(".action-menu-item")].map((n) => n.textContent);
ok("the menu renders exactly the actions the server offered", items.length === 2, `got ${items.length}: ${items}`);
ok("a danger action is marked as one", menu.querySelector(".is-danger") !== null);

// The old panel had LEGAL_NEXT_STATUS in the browser. That table must not come
// back: it is a second copy of the server's rules and it is what drifts.
const bundle = readdirSync(distDir).find((f) => /^admin\..*\.min\.js$/.test(f));
const source = readFileSync(join(distDir, bundle), "utf8");
ok("the shipped admin bundle contains no browser-side transition table",
  !/awaiting_payment:\s*\[\s*"/.test(source),
  "a status -> next-status map was found in the bundle");
ok("the shipped admin bundle contains no innerHTML with a template literal",
  !/innerHTML\s*=\s*`/.test(source) && !/innerHTML\s*\+=/.test(source));

/* ---- no backend secret reaches the browser ---- */

const adminHtml = readFileSync(join(distDir, "admin/index.html"), "utf8");
const adminCss = readFileSync(join(distDir, readdirSync(distDir).find((f) => /^admin\..*\.min\.css$/.test(f))), "utf8");
for (const [label, haystack] of [["admin HTML", adminHtml], ["admin bundle", source], ["admin CSS", adminCss]]) {
  for (const secret of ["DATABASE_URL", "OPAY_SECRET_KEY", "TURNSTILE_SECRET", "WEBHOOK_SECRET", "RECONCILE_CRON_SECRET", "OPAY_PRIVATE"]) {
    ok(`${label} does not contain ${secret}`, !haystack.includes(secret));
  }
}

/* ---- the primitives the screens are built from actually exist ---- */

ok("statusBadge renders a neutral badge for an unknown status",
  statusBadge("something_new").className.includes("badge-neutral"));
ok("resultCount says 0 records rather than nothing at all",
  resultCount({ page: { total: 0, totalPages: 1, page: 1, pageSize: 50 } }).textContent === "0 records");
ok("resultCount reports the page when there is more than one",
  resultCount({ page: { total: 95, totalPages: 5, page: 2, pageSize: 20 } }).textContent.includes("page 2 of 5"));

/* ---- the xlsx writer produces a file a spreadsheet will actually open ---- */

// A minimal ZIP reader: walk the end-of-central-directory record, then the
// central directory, and pull each STORED entry back out. Re-implemented HERE
// rather than imported from the module under test, because a writer bug and a
// reader bug only cancel each other out when they are independent.
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries = {};
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`bad central header at ${at}`);
    const method = view.getUint16(at + 10, true);
    const expectedCrc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (method !== 0) throw new Error(`${name}: expected a STORED entry`);
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true)
      + view.getUint16(localOffset + 28, true);
    const data = bytes.subarray(dataStart, dataStart + size);
    if (crc32(data) !== expectedCrc) throw new Error(`${name}: CRC mismatch`);
    entries[name] = data;
    at += 46 + nameLen;
  }
  return entries;
}

const OOXML_PARTS = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"];

ok("crc32 matches the published IEEE vector",
  crc32(new TextEncoder().encode("123456789")) === 0xCBF43926,
  `got ${crc32(new TextEncoder().encode("123456789"))}`);

const sampleXlsx = buildXlsx([
  ["Order ID", "Name", "Address"],
  ["ord-abc-12345678", 'O"Brien & <Son>', "12 Allen Ave, Ikeja"],
]);
ok("buildXlsx starts with the ZIP local-header signature",
  sampleXlsx[0] === 0x50 && sampleXlsx[1] === 0x4B && sampleXlsx[2] === 0x03 && sampleXlsx[3] === 0x04,
  `got ${[...sampleXlsx.slice(0, 4)].map((b) => b.toString(16)).join(" ")}`);

// unzip() THROWS on a bad signature, a non-stored entry or a CRC mismatch, so
// reaching these assertions already proves the archive is well-formed.
const sampleFiles = unzip(sampleXlsx);
ok("all five OOXML parts are present and every CRC verifies",
  OOXML_PARTS.every((part) => part in sampleFiles),
  Object.keys(sampleFiles).join(", "));
const sampleSheet = new TextDecoder().decode(sampleFiles["xl/worksheets/sheet1.xml"]);
ok("cell text lands in the sheet as inline strings",
  sampleSheet.includes("ord-abc-12345678") && sampleSheet.includes("12 Allen Ave, Ikeja"));
ok("XML metacharacters are escaped rather than passed through",
  sampleSheet.includes("O&quot;Brien &amp; &lt;Son&gt;") && !sampleSheet.includes("<Son>"),
  sampleSheet.slice(0, 300));
ok("an empty matrix still yields a complete archive, not an empty one",
  OOXML_PARTS.every((part) => part in unzip(buildXlsx([]))));

/* ---- every navigation entry boots and shows its own content ---- */

// The bug this section exists for: the shell drew and every panel was blank,
// because render() referenced a shell that lived in boot()'s scope. Nothing else
// would have caught it - the unit checks above all pass with a broken router. So
// the whole app is booted here, against a stubbed API, and each route is visited.
//
// A stub API, not a real one: this is about the ROUTER and the VIEWS drawing, and
// pinning "this is the shape the server sends" as well would only mean two places
// to update when it changes.
function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const PAGE = { page: 1, pageSize: 50, total: 1, totalPages: 1, hasNext: false, hasPrev: false };
const STUB = {
  "/admin/me": { email: "owner@example.com", permissions: ["orders:read", "orders:write", "orders:delete", "orders:payment-override", "categories:read", "categories:write", "products:read", "products:write", "media:read", "media:write", "settings:write"] },
  "/admin/orders": { orders: [
    { id: 1, reference: "ddmd-a1b2c3d4e5f6071", createdAt: "2026-01-01T10:00:00Z", customerName: "Chioma", phone: "08012345678", whatsapp: "08012345678", address: "12 Allen Ave", state: "Lagos", productName: "Glow", productSlug: "glow", categoryName: "Skin", quantity: 1, unitPrice: 100, subtotal: 100, discountPercent: 0, discountAmount: 0, amount: 100, currency: "NGN", paymentMethod: "cod", status: "paid", deliveredAt: null, updatedAt: "2026-01-01T10:00:00Z", actions: ["deliver", "cancel", "mark-not-picking"] },
    { id: 2, reference: "ddmd-e5f60718a1b2c3d", createdAt: "2026-01-02T09:30:00Z", customerName: "Adaeze", phone: "07098765432", whatsapp: "07098765432", address: "5 Ogudu Road", state: "Lagos", productName: "Serum", productSlug: "serum", categoryName: "Skin", quantity: 3, unitPrice: 100, subtotal: 300, discountPercent: 0, discountAmount: 0, amount: 300, currency: "NGN", paymentMethod: "transfer", status: "paid", deliveredAt: null, updatedAt: "2026-01-02T09:30:00Z", actions: ["deliver", "cancel", "mark-not-picking"] },
  ], page: { ...PAGE, total: 2 } },
  "/admin/orders/csv": { csv: "id,reference\n1,ddmd-a1b2c3d4e5f6071" },
  "/admin/orders/1": { order: { id: 1, reference: "ddmd-a1b2c3d4e5f6071", customerName: "Chioma", phone: "08012345678", whatsapp: "08012345678", address: "12 Allen Ave", state: "Lagos", productName: "Glow", productSlug: "glow", quantity: 1, unitPrice: 100, discountPercent: 0, discountAmount: 0, amount: 100, currency: "NGN", paymentMethod: "cod", status: "cancelled", deliveredAt: null, createdAt: "2026-01-01T10:00:00Z", updatedAt: "2026-01-01T10:00:00Z", actions: ["revert-cancel"] }, history: [] },
  "/admin/categories": { categories: [{ id: 1, name: "Skin Cares", slug: "skin-cares", productCount: 1, sortOrder: 0, isActive: true, mediaR2Key: "", updatedAt: "2026-01-01T10:00:00Z" }], page: PAGE },
  "/admin/categories/tree": { tree: [{ id: 1, name: "Skin Cares", children: [] }] },
  "/admin/products": { products: [{ id: 1, slug: "glow", name: "Glow", price: 100, active: true, categoryId: 1, categoryName: "Skin Cares", updatedAt: "2026-01-01T10:00:00Z" }], page: PAGE },
  "/admin/media": { media: [{ id: 1, r2Key: "uploads/a.jpg", contentType: "image/jpeg", byteSize: 1024, width: 100, height: 100, inUse: false, createdAt: "2026-01-01T10:00:00Z" }], page: PAGE },
  "/admin/testimonials": { testimonials: [{ id: 1, title: "Works", kind: "review", productId: 1, r2Key: "", displayOrder: 0, active: true }] },
  "/admin/discount-tiers": { tiers: [{ minQuantity: 1, discountPercent: 0, label: "", active: true }] },
  "/admin/payment-rules": { paymentRules: { codStates: ["Lagos"], codBulkThreshold: 5 } },
  "/admin/reports/monthly-kpis": {
    reports: [{
      month: "2026-09",
      current: true,
      totalOrders: 7,
      totalValidOrders: 6,
      deliveredOrders: 1,
      deliveredRevenue: 150000,
      deliveredInMonth: 1,
      collectedAmount: null,
      awaitingPaymentOrders: 1,
      paidOrders: 1,
      failedOrders: 1,
      confirmedCodOrders: 1,
      deliveredStatusOrders: 1,
      cancelledOrders: 1,
      notPickingOrders: 1,
      spamFlaggedOrders: 1,
      abuseEvidenceOrders: 2,
      payNowOrders: 3,
      codOrders: 4,
      snapshot: null,
    }],
    collectionAvailable: false,
    collectionUnavailableReason: "Collected cash is unavailable without a persisted collection record.",
    deliveryTimingNote: "Legacy delivery times may be approximate.",
  },
  "/admin/reports/visitors": {
    trackingStartedOn: "2026-09-30",
    today: "2026-10-09",
    dailyRange: { from: "2026-09-30", to: "2026-10-09" },
    daily: [
      { date: "2026-10-07", visitors: 1 },
      { date: "2026-10-08", visitors: 3 },
      { date: "2026-10-09", visitors: 2 },
    ],
    monthly: [{ month: "2026-09", visitors: 6 }, { month: "2026-10", visitors: 9 }],
    yearly: [{ year: 2026, visitors: 11, complete: false, current: true }],
    geographyApproximate: true,
    geography: [{ country: "NG", region: "Lagos", visitorDays: 12 }],
    notice: "Distinct visitor counts are not additive across days, months or years.",
  },
};

const requested = [];
const requestedUrls = [];
const posted = [];
let reportDelay = 0;
// Defined once as a factory, because `fetch` must be installed on EACH window the
// bundle runs in. Setting it on globalThis is not enough: the bundle is evaluated
// with window.eval, so its bare `fetch(...)` resolves against that window, not
// against Node's global. Assigning only the global left every route calling jsdom's
// real fetch, which produced an HTML body, which failed JSON.parse, which surfaced
// as "b.text is not a function" — a failure in the harness wearing the costume of
// a bug in the console.
const stubFetch = () => async (input, init) => {
  const url = String(input);
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  requested.push(path);
  requestedUrls.push(url);
  // Request BODIES are recorded too, because "the reason is sent" is only
  // provable by seeing it on the wire - a dialog that collects text and posts
  // nothing would otherwise look identical to one that works.
  if (init && typeof init.body === "string") {
    try { posted.push({ path, body: JSON.parse(init.body) }); }
    catch { posted.push({ path, body: null }); }
  }
  if (path === "/admin/reports/monthly-kpis" && reportDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, reportDelay));
  }
  if (path === "/admin/reports/monthly-kpis" && url.includes("months=24")) {
    return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Report unavailable" } }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  if (Object.prototype.hasOwnProperty.call(STUB, path)) return jsonResponse(STUB[path]);
  return jsonResponse({});
};
dom.window.fetch = stubFetch();

const routeIds = ["orders", "reports", "categories", "products", "media", "testimonials", "discounts", "payment"];
// A fresh document per route, because each view module keeps its own state and
// reusing one would let a leaked selection from a previous route look like a pass.
for (const id of routeIds) {
  // `runScripts: "outside-only"` is load-bearing. Without it jsdom does not set up
// the script-running context at all, so `window.eval(bundle)` runs with the wrong
// scope and every route reported an empty <main> - a harness that fails for its
// own reasons looks exactly like a broken console. "outside-only" gives a real
// window context for eval() while still executing nothing the document contains
// on its own, which is what we want: this test decides what runs, not the page.
const page = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", {
    url: `http://localhost:8787/admin/#${id}`,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  // The bundle resolves `fetch` against THIS window, so it has to be installed here
  // and not merely on globalThis.
  page.window.fetch = stubFetch();
  // jsdom implements neither TextEncoder nor TextDecoder; every browser has had
  // both for years and the xlsx writer encodes UTF-8 with the platform one.
  // Node's implementation is spec-identical, so it stands in here rather than
  // the writer growing a bespoke encoder to satisfy the test DOM.
  page.window.TextEncoder ??= globalThis.TextEncoder;
  page.window.TextDecoder ??= globalThis.TextDecoder;
  for (const key of ["window", "document", "Node", "navigator", "location", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? page.window : key === "document" ? page.window.document : page.window[key], configurable: true, writable: true });
  }
  // The bundle is loaded as the real page would load it, so a scoping mistake in
  // admin.js is reproduced here exactly as the browser reproduced it.
  page.window.eval(readFileSync(join(distDir, bundle), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 60));

  const app = page.window.document.getElementById("app");
  const main = app.querySelector(".main");
  ok(`#${id} draws a page title`, Boolean(main?.querySelector(".page-title")?.textContent?.trim()),
    `main was empty: ${main ? "present but no title" : "no .main at all"}`);
  ok(`#${id} draws real content, not a blank panel`,
    Boolean(main?.querySelector(".list-panel, .panel-body")),
    "the view mounted no panel");
  if (id === "orders") {
    const statusFilter = main.querySelector('select[aria-label="Status"]');
    const actionFilter = main.querySelector('select[aria-label="Available action"]');
    ok("order status filter includes Cancelled and Not Picking",
      statusFilter?.querySelector('option[value="cancelled"]') !== null
        && statusFilter?.querySelector('option[value="not_picking"]') !== null);
    ok("orders can be filtered by available action",
      actionFilter?.querySelector('option[value="cancel"]') !== null
        && actionFilter?.querySelector('option[value="mark-not-picking"]') !== null);

    main.querySelector(".action-menu-trigger")?.click();
    const menuText = main.querySelector(".action-menu")?.textContent || "";
    ok("Cancel and Not Picking are available in the row action dropdown",
      menuText.includes("Cancel order") && menuText.includes("Mark Not Picking"));
    ok("reversal actions stay out of the row action dropdown",
      !menuText.includes("Revert"));

    /* ---- cancel must record WHY ---- */
    const cancelItem = [...main.querySelectorAll(".action-menu button, .action-menu [role='menuitem'], .action-menu li")]
      .find((node) => node.textContent.trim() === "Cancel order");
    ok("the Cancel order menu item is clickable", Boolean(cancelItem),
      `menu was: ${main.querySelector(".action-menu")?.textContent}`);
    cancelItem?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelDialog = [...page.window.document.querySelectorAll(".dialog")]
      .find((d) => d.textContent.includes("Cancel this order?"));
    ok("Cancel opens a dialog with a required reason box", Boolean(cancelDialog?.querySelector("textarea")),
      "no reason dialog appeared");
    const cancelConfirm = [...(cancelDialog?.querySelectorAll("button") || [])]
      .find((b) => b.textContent.trim() === "Cancel order");
    ok("confirm is disabled while the reason box is empty", cancelConfirm?.disabled === true,
      `disabled=${cancelConfirm?.disabled}`);

    const reasonBox = cancelDialog?.querySelector("textarea");
    if (reasonBox && cancelConfirm) {
      reasonBox.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      ok("Enter in the reason box does not submit or close the dialog",
        !page.window.document.querySelector(".dialog") === false
        && posted.every((p) => p.path !== "/admin/orders/1/cancel"));

      reasonBox.value = "Customer asked to stop the order";
      reasonBox.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      ok("a real reason enables the confirm button", cancelConfirm.disabled === false,
        `disabled=${cancelConfirm.disabled}`);

      cancelConfirm.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const cancelPost = posted.find((p) => p.path === "/admin/orders/1/cancel");
      ok("the cancel request carries the trimmed reason",
        cancelPost?.body?.reason === "Customer asked to stop the order",
        `posted=${JSON.stringify(posted)}`);
      ok("the cancel dialog closes after success",
        ![...page.window.document.querySelectorAll(".dialog")]
          .some((d) => d.textContent.includes("Cancel this order?")));
    } else {
      ok("cancel dialog has a reason box and confirm button", false);
    }

    main.querySelector("tbody tr")?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const detailActions = page.window.document.querySelector(".detail-actions");
    const detailActionLabels = [...(detailActions?.querySelectorAll("button") || [])]
      .map((button) => button.textContent.trim());
    ok("the order detail modal offers a Revert control",
      detailActionLabels.includes("Revert"));
    ok("the detail modal does not offer forward cancellation or Not Picking actions",
      !detailActionLabels.includes("Cancel order") && !detailActionLabels.includes("Mark Not Picking"));

    /* ---- the filter bar keeps every filter the operator picks ---- */
    // The controls are built ONCE, so a pick used to spread the build-time
    // snapshot and drop the other filters from the request while the other
    // selects kept displaying them. Each change fires its own request, so the
    // LAST orders URL is the one that proves what was actually sent.
    const orderFilterSelects = [...main.querySelectorAll(".filters select")];
    ok("the orders filter bar renders its three filters", orderFilterSelects.length === 3,
      `found ${orderFilterSelects.length}`);
    const [ordersStatusPick, , ordersPaymentPick] = orderFilterSelects;
    ordersStatusPick.value = "delivered";
    ordersStatusPick.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ordersPaymentPick.value = "cod";
    ordersPaymentPick.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const filteredOrdersUrl = requestedUrls.filter((url) => url.startsWith("/admin/orders?")).pop() || "";
    ok("a second filter change sends BOTH filters to the API",
      filteredOrdersUrl.includes("status=delivered") && filteredOrdersUrl.includes("paymentMethod=cod"),
      `last orders request: ${filteredOrdersUrl}`);
    ok("the status select still shows the operator's choice", ordersStatusPick.value === "delivered");

    /* ---- selection: a tick must SURVIVE its own re-render ---- */
    // The bug: render() began with state.selected.clear(), and a checkbox's
    // onchange re-renders - so ticking erased itself one frame later and the
    // bulk bar (gated on state.selected.size) could never appear at all.
    const tickBoxes = () => [...main.querySelectorAll("tbody input[type=checkbox]")];
    ok("every order row renders a checkbox", tickBoxes().length === 2,
      `found ${tickBoxes().length}`);
    tickBoxes()[0].checked = true;
    tickBoxes()[0].dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    ok("a ticked box is still ticked after the re-render",
      tickBoxes()[0]?.checked === true, `checked: ${tickBoxes()[0]?.checked}`);
    ok("the bulk bar appears with 1 selected",
      main.querySelector(".bulk-bar .bulk-count")?.textContent === "1 selected",
      `got: ${main.querySelector(".bulk-bar .bulk-count")?.textContent}`);
    tickBoxes()[1].checked = true;
    tickBoxes()[1].dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    ok("a second tick counts up - the first selection survived",
      main.querySelector(".bulk-bar .bulk-count")?.textContent === "2 selected",
      `got: ${main.querySelector(".bulk-bar .bulk-count")?.textContent}`);

    // A new result set arrives on a filter change; rows the operator can no
    // longer see must not stay selected.
    ordersStatusPick.value = "paid";
    ordersStatusPick.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    ok("a filter change clears the selection with the old result set",
      main.querySelector(".bulk-bar") === null && !tickBoxes().some((box) => box.checked),
      `bulk bar present: ${Boolean(main.querySelector(".bulk-bar"))}`);

    /* ---- selection-aware export/copy: ticked rows win, else the page ---- */
    tickBoxes()[0].checked = true;
    tickBoxes()[0].dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const bulkLabels = [...main.querySelectorAll(".bulk-bar button")]
      .map((button) => button.textContent.trim());
    ok("the bulk bar offers export and copy of exactly the selection",
      bulkLabels.includes("Export (.xlsx)") && bulkLabels.includes("Copy as text"),
      bulkLabels.join(" | "));
    const pageButtons = [...main.querySelectorAll(".list-actions button")]
      .map((button) => button.textContent.trim());
    ok("the page export/copy buttons switch to the selection when rows are ticked",
      pageButtons.includes("Export selected (.xlsx)") && pageButtons.includes("Copy selected as text"),
      pageButtons.join(" | "));
    // Back to unselected so the page-level export assertions below start clean.
    main.querySelector(".bulk-bar .button-link")?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    ok("clearing the selection restores the page-level buttons",
      [...main.querySelectorAll(".list-actions button")]
        .some((button) => button.textContent.trim() === "Export page (.xlsx)"),
      [...main.querySelectorAll(".list-actions button")].map((b) => b.textContent.trim()).join(" | "));

    /* ---- export: ONE column list, .xlsx file AND tab-separated copy ---- */

    // Everything the writer touches is intercepted at its seam: Blob captures
    // the raw bytes as built, createObjectURL never has to produce a real URL,
    // and the anchor's click records the filename instead of navigating jsdom.
    const downloads = [];
    const blobParts = [];
    const blobOptions = [];
    const SavedBlob = page.window.Blob;
    page.window.Blob = function CapturingBlob(parts, options) {
      blobParts.push(parts);
      blobOptions.push(options);
      return new SavedBlob(parts, options);
    };
    page.window.URL.createObjectURL = () => "blob:orders-test";
    page.window.URL.revokeObjectURL = () => {};
    const savedAnchorClick = page.window.HTMLAnchorElement.prototype.click;
    page.window.HTMLAnchorElement.prototype.click = function record() {
      downloads.push({ name: this.getAttribute("download"), href: this.getAttribute("href") });
    };
    const savedExecCommand = document.execCommand;
    let clipboardText = null;
    document.execCommand = (command) => {
      if (command !== "copy") return false;
      clipboardText = document.querySelector("body > textarea[readonly]")?.value ?? null;
      return true;
    };

    const EXPORT_HEADERS = ["Order ID", "Date", "Name", "Phone", "WhatsApp", "Product / Qty", "Address", "Status"];
    const exportPage = [...main.querySelectorAll("button")]
      .find((button) => button.textContent.trim() === "Export page (.xlsx)");
    ok("the orders list offers an .xlsx export", Boolean(exportPage));
    exportPage?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    ok("the export downloads a file named for the day",
      downloads.length === 1 && /^orders-\d{4}-\d{2}-\d{2}\.xlsx$/.test(downloads[0]?.name || ""),
      JSON.stringify(downloads));
    ok("the downloaded object is an OOXML spreadsheet blob",
      blobOptions[0]?.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      `type: ${blobOptions[0]?.type}`);
    const exportedBytes = blobParts[0]?.[0];
    // ArrayBuffer.isView, not instanceof: the bundle builds its bytes inside the
    // jsdom realm, whose Uint8Array is a DIFFERENT intrinsic from Node's - the
    // signature below is the real assertion, the view check only rules out a
    // plain array that would have slipped past it.
    ok("the exported bytes start with the ZIP signature",
      ArrayBuffer.isView(exportedBytes)
        && exportedBytes[0] === 0x50 && exportedBytes[1] === 0x4B,
      `first bytes: ${exportedBytes && [...exportedBytes.slice(0, 4)].join(",")}`);
    const exportedFiles = unzip(exportedBytes);
    ok("the export contains all five OOXML parts",
      OOXML_PARTS.every((part) => part in exportedFiles),
      Object.keys(exportedFiles).join(", "));
    const exportedSheet = new TextDecoder().decode(exportedFiles["xl/worksheets/sheet1.xml"]);
    ok("the export carries exactly the eight informational columns",
      EXPORT_HEADERS.every((header) => exportedSheet.includes(`>${header}</t>`)),
      EXPORT_HEADERS.filter((header) => !exportedSheet.includes(`>${header}</t>`)).join(", "));
    ok("both rows' information is in the sheet",
      ["ddmd-a1b2c3d4e5f6071", "Chioma", "08012345678", "12 Allen Ave", "Glow ×1", "Jan",
        "ddmd-e5f60718a1b2c3d", "Adaeze", "Serum ×3", "paid"]
        .every((value) => exportedSheet.includes(value)),
      ["ddmd-a1b2c3d4e5f6071", "Chioma", "08012345678", "12 Allen Ave", "Glow ×1", "Jan",
        "ddmd-e5f60718a1b2c3d", "Adaeze", "Serum ×3", "paid"]
        .filter((value) => !exportedSheet.includes(value)).join(", "));
    ok("the dropped columns stayed dropped",
      ["unitPrice", "amount", "currency", "productSlug", "kobo"]
        .every((dropped) => !exportedSheet.includes(`>${dropped}</t>`)),
      ["unitPrice", "amount", "currency", "productSlug", "kobo"]
        .filter((dropped) => exportedSheet.includes(`>${dropped}</t>`)).join(", "));

    const copyPage = [...main.querySelectorAll("button")]
      .find((button) => button.textContent.trim() === "Copy page as text");
    ok("the orders list offers a paste-ready text copy", Boolean(copyPage));
    copyPage?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const copiedLines = (clipboardText || "").split("\n");
    ok("the text copy is tab-separated with the same eight columns",
      copiedLines[0] === EXPORT_HEADERS.join("\t"),
      `got: ${JSON.stringify(copiedLines[0])}`);
    ok("each order is one pasteable line",
      copiedLines.length === 3
        && copiedLines[1].startsWith("ddmd-a1b2c3d4e5f6071\t")
        && copiedLines[1].includes("\tChioma\t")
        && copiedLines[2].startsWith("ddmd-e5f60718a1b2c3d\t")
        && copiedLines[2].includes("\tAdaeze\t"),
      `got ${copiedLines.length} lines: ${JSON.stringify(copiedLines)}`);

    // The row menu offers the SAME column list for one order.
    main.querySelector(".action-menu-trigger")?.click();
    const rowMenuLabels = [...main.querySelectorAll(".action-menu button")]
      .map((button) => button.textContent.trim());
    ok("the row menu offers the per-order export and text copy",
      rowMenuLabels.includes("Export order (.xlsx)") && rowMenuLabels.includes("Copy order as text"),
      rowMenuLabels.join(" | "));
    [...main.querySelectorAll(".action-menu button")]
      .find((button) => button.textContent.trim() === "Export order (.xlsx)")?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    ok("the row export downloads one order under its reference",
      downloads.length === 2 && downloads[1]?.name === "order-ddmd-a1b2c3d4e5f6071.xlsx",
      JSON.stringify(downloads));
    main.querySelector(".action-menu-trigger")?.click();
    [...main.querySelectorAll(".action-menu button")]
      .find((button) => button.textContent.trim() === "Copy order as text")?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const rowCopyLines = (clipboardText || "").split("\n");
    ok("the row copy puts the header and that one order on the clipboard",
      rowCopyLines.length === 2 && rowCopyLines[1].startsWith("ddmd-a1b2c3d4e5f6071\t"),
      `got ${rowCopyLines.length} lines: ${JSON.stringify(rowCopyLines)}`);

    ok("the panel no longer calls the server CSV endpoint",
      !requestedUrls.some((url) => url.includes("/admin/orders/csv")),
      requestedUrls.filter((url) => url.includes("/admin/orders/csv")).join(", "));

    page.window.Blob = SavedBlob;
    delete page.window.URL.createObjectURL;
    delete page.window.URL.revokeObjectURL;
    page.window.HTMLAnchorElement.prototype.click = savedAnchorClick;
    if (savedExecCommand === undefined) delete document.execCommand;
    else document.execCommand = savedExecCommand;
  }
  if (id === "reports") {
    ok("the report requests the monthly KPI API",
      requested.includes("/admin/reports/monthly-kpis"));
    ok("the report renders delivery rate and order value",
      main.textContent.includes("Delivery rate") && main.textContent.includes("₦1,500"));
    ok("the report states collected cash is unavailable rather than showing zero",
      main.textContent.includes("Collected cash") && main.textContent.includes("Not reported")
        && main.textContent.includes("persisted collection record"));
    ok("the report shows each order lifecycle status separately",
      ["Awaiting payment", "Failed", "Confirmed COD", "Paid", "Delivered (all)", "Cancelled", "Not Picking"]
        .every((label) => main.textContent.includes(label)));

    // Delivery-performance line chart + lifecycle status side summary. The chart
    // is real SVG (createElementNS), the summary lists every status with counts,
    // and monetary amounts are kept distinct from counts / collected cash.
    ok("the report renders a delivered-rate line chart",
      Boolean(main.querySelector(".chart svg.chart-svg polyline.chart-line")));
    ok("the delivery chart is labelled as a rate over time",
      /Delivered-order rate over time/.test(main.textContent));
    ok("the report shows a lifecycle status side summary with counts",
      Boolean(main.querySelector(".report-side .status-list .status-item"))
      && main.textContent.includes("Order status totals"));
    ok("the status summary keeps delivered order value separate from collected cash",
      main.textContent.includes("Delivered order value")
      && main.textContent.includes("Collected cash"));

    // Visitor trend chart — separate from the sales/delivery chart — with real
    // backend daily data and the non-additive distinct-count notice.
    ok("the report requests the visitor analytics API",
      requested.includes("/admin/reports/visitors"));
    ok("the report renders a daily visitor line chart",
      /Daily visitors/.test(main.textContent)
      && Boolean([...main.querySelectorAll(".chart svg.chart-svg")].length >= 2));
    ok("the visitor report states distinct counts are not additive",
      /not additive/i.test(main.textContent));
    ok("the visitor geography is labelled approximate and hides raw IPs",
      /Approximate geography/.test(main.textContent));

    // Daily visitor paging + date filter: the series opens on the LAST 10 Lagos
    // days (sent as ?from=&to= on the wire), Prev/Next page the window, and a
    // from/to filter offers jumping anywhere inside the backend's range cap.
    const visitClock = (() => {
      const now = new Date(Date.now() + 36e5).toISOString().slice(0, 10);
      const [yy, mm, dd] = now.split("-").map(Number);
      const shift = (n) => new Date(Date.UTC(yy, mm - 1, dd + n)).toISOString().slice(0, 10);
      return { now, from10: shift(-9), prev10: shift(-10), from20: shift(-19) };
    })();
    ok("the visitor daily series defaults to the last 10 Lagos days",
      requestedUrls.some((url) => url.includes(
        `/admin/reports/visitors?from=${visitClock.from10}&to=${visitClock.now}`)));
    ok("the report shows the loaded daily window",
      main.textContent.includes("2026-09-30 → 2026-10-09"));
    const visitButtons = [...main.querySelectorAll(".visit-controls button")];
    const prevButton = visitButtons.find((button) => /Previous/.test(button.textContent));
    const nextButton = visitButtons.find((button) => /Next/.test(button.textContent));
    ok("the visitor window is paged with Previous and Next",
      Boolean(prevButton) && Boolean(nextButton));
    ok("the visitor window stops paging at today",
      nextButton && nextButton.disabled === (visitClock.now >= "2026-10-09"));
    ok("the visitor report offers a from/to date filter",
      Boolean(main.querySelector("#visit-from")) && Boolean(main.querySelector("#visit-to")));
    ok("the daily window reports its visitor-day page total",
      /page total [\d,]+ visitor-days/.test(main.textContent));
    if (prevButton) {
      prevButton.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      ok("Previous pages the visitor window back by 10 Lagos days",
        requestedUrls.some((url) => url.includes(
          `/admin/reports/visitors?from=${visitClock.from20}&to=${visitClock.prev10}`)));
    }

    const windowSelect = main.querySelector("#report-month-window");
    windowSelect.value = "24";
    reportDelay = 100;
    windowSelect.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    ok("the report shows a loading state while the API is pending",
      Boolean(main.querySelector(".list-results.is-loading .list-pending")));
    await new Promise((resolve) => setTimeout(resolve, 120));
    reportDelay = 0;
    ok("the report month filter requests the selected 24-month window",
      requestedUrls.some((url) => url.includes("/admin/reports/monthly-kpis?months=24")));
    ok("the report displays its API error state",
      Boolean(main.querySelector(".table-state-error"))
        || page.window.document.querySelector(".table-state-error")?.textContent.includes("Report unavailable"));
  }
  if (id === "products") {
    // The same built-once snapshot bug, with two filters: pick a category, then
    // a state - the category must still be on the request that the second pick
    // fires, and the last products URL proves it.
    const productFilters = [...main.querySelectorAll(".filters select")];
    ok("the products filter bar renders category and state filters", productFilters.length === 2,
      `found ${productFilters.length}`);
    const [categoryFilter, stateFilter] = productFilters;
    categoryFilter.value = "1";
    categoryFilter.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stateFilter.value = "true";
    stateFilter.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const filteredProductsUrl = requestedUrls.filter((url) => url.startsWith("/admin/products?")).pop() || "";
    ok("the state filter does not drop the chosen category",
      filteredProductsUrl.includes("categoryId=1") && filteredProductsUrl.includes("active=true"),
      `last products request: ${filteredProductsUrl}`);
  }
  if (id === "categories") {
    // The Show filter's no-op is "" (the primitive's own first option), not
    // "all". Seeding state.filter with the backend's explicit default made
    // active() count it as applied: "Clear filters" showed on a freshly loaded
    // list, and clicking it re-sent the same query - the button vanished while
    // nothing on screen changed, which reads as a broken control.
    const showSelect = main.querySelector(".filters select");
    ok("the categories Show filter renders", Boolean(showSelect),
      "no .filters select in the categories controls");
    const categoriesUrls = () => requestedUrls.filter((url) => url.startsWith("/admin/categories?"));
    const firstCategoriesUrl = categoriesUrls()[0] || "";
    ok("an unfiltered categories load omits the filter parameter",
      !firstCategoriesUrl.includes("filter="), `first request: ${firstCategoriesUrl}`);
    const clearOnLoad = [...main.querySelectorAll(".filters button")]
      .find((button) => button.textContent.trim() === "Clear filters");
    ok("no Clear filters button on an unfiltered categories list",
      !clearOnLoad || clearOnLoad.hidden,
      clearOnLoad ? "the clear button is visible on the default state" : "");
    const showOptions = [...(showSelect?.querySelectorAll("option") || [])];
    ok("the Show filter offers a single All entry",
      showOptions.length === 4 && showOptions.filter((option) => option.textContent === "All").length === 1,
      showOptions.map((option) => option.textContent).join(" | "));

    showSelect.value = "unused";
    showSelect.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const clearAfterPick = [...main.querySelectorAll(".filters button")]
      .find((button) => button.textContent.trim() === "Clear filters");
    ok("picking a filter reveals Clear filters", Boolean(clearAfterPick) && !clearAfterPick.hidden);
    ok("the pick reaches the API", (categoriesUrls().pop() || "").includes("filter=unused"),
      `last request: ${categoriesUrls().pop() || ""}`);
    clearAfterPick?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    ok("clearing resets the Show filter, hides the button, and drops the parameter",
      showSelect.value === "" && clearAfterPick?.hidden === true
        && !(categoriesUrls().pop() || "").includes("filter="),
      `select: "${showSelect.value}", last request: ${categoriesUrls().pop() || ""}`);
  }
  if (id === "media") {
    // Same no-op convention as categories: nothing is applied on load, so the
    // Clear button stays hidden and the dropdown has one All entry.
    const mediaSelect = main.querySelector(".filters select");
    const mediaClear = [...main.querySelectorAll(".filters button")]
      .find((button) => button.textContent.trim() === "Clear filters");
    ok("no Clear filters button on an unfiltered media list",
      !mediaClear || mediaClear.hidden,
      mediaClear ? "the clear button is visible on the default state" : "");
    const mediaOptions = [...(mediaSelect?.querySelectorAll("option") || [])];
    ok("the media Show filter offers a single All entry",
      mediaOptions.length === 3 && mediaOptions.filter((option) => option.textContent === "All").length === 1,
      mediaOptions.map((option) => option.textContent).join(" | "));
  }
}

/* ---- the two defects that blanked the console ---- */

// 1. A missing import. `views/orders.js` used ApiError without importing it, so
// marking an order delivered threw a ReferenceError that escaped to the window
// handler and replaced the whole screen with "This screen failed to load".
//
// This cannot be caught by booting a route: nothing on the orders LISTING path
// touches ApiError, so every route rendered perfectly while the feature was
// broken. What is checked instead is the invariant that would have caught it -
// every module-level identifier a view uses must be one it imported or declared.
// That is a static property of the source, so it is checked statically.
// The set of names the sibling modules export. A name that is in here, is USED in a
  // scanned file, and is NOT imported into that file, is a guaranteed ReferenceError.
  //
  // This is deliberately a closed set rather than a general "is every identifier
  // bound" analysis. A general one flags `if`, `catch`, `return`, every local and
  // every parameter - and when the output is 20 false positives the two real defects
  // this exists to catch (`ApiError` in orders.js, `qs` in ui.js) disappear into the
  // noise. Naming the exact shape of the bug keeps it checkable.
const moduleExports = new Set();
for (const rel of ["ui.js", "api.js", "dom.js", "xlsx.js"]) {
  const src = readFileSync(join(siteRoot, "shared", "scripts", "admin", rel), "utf8");
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/g)) {
    moduleExports.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) moduleExports.add(name);
    }
  }
}

// Two real defects of exactly this shape, both mine, both invisible until a click:
//   - orders.js used `ApiError` without importing it, so marking an order delivered
//     threw a ReferenceError that replaced the whole screen.
//   - ui.js used `qs(...)` without importing it, so every image-picker load threw
//     and its own catch rendered a perfectly plausible "no images found".
const viewsDir = join(siteRoot, "shared", "scripts", "admin", "views");
// ui.js is scanned too, and not as an afterthought: the `qs` defect lived there, in
// the module every view depends on, so a views-only scan would have missed the one
// file where an un-imported helper does the most damage.
const scannedFiles = [
  ...readdirSync(viewsDir).filter((f) => f.endsWith(".js")).map((f) => join(viewsDir, f)),
  join(siteRoot, "shared", "scripts", "admin", "ui.js"),
  join(siteRoot, "shared", "scripts", "admin", "api.js"),
  join(siteRoot, "shared", "scripts", "admin", "xlsx.js"),
];
const EXPECTED = {
  // Identifiers a view may use without importing: JS builtins and globals.
  globals: new Set(["window", "document", "console", "fetch", "FormData", "File", "Blob", "URL",
    "AbortController", "setTimeout", "clearTimeout", "navigator", "location", "JSON", "Object",
    "Array", "Number", "String", "Boolean", "Date", "Math", "Promise", "Map", "Set", "undefined",
    "globalThis", "isFinite", "isNaN", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent",
    "Uint8Array", "Uint32Array", "DataView", "TextEncoder"]),
};

for (const path of scannedFiles) {
  const file = path.slice(path.lastIndexOf("\\") + 1);
  const source = readFileSync(path, "utf8");

  // Strip strings, template literals and comments so a word inside a message cannot
  // be mistaken for a reference.
  //
  // A template literal keeps only its INTERPOLATIONS. Blanking the whole thing is
  // what made this check miss `qs` entirely: its only call site is
  // `api.get(`/media${qs({...})}`)`, so the template blank removed the very call the
  // check exists to find - and it "passed" over the defect it was written for.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, (tmpl) => {
      let kept = "";
      for (const part of tmpl.matchAll(/\$\{([\s\S]*?)\}/g)) kept += ` ${part[1]} `;
      return kept || " ";
    })
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");

  // Everything imported, plus everything declared at module scope.
  const imported = new Set();
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) imported.add(name);
    }
  }
  for (const m of code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) imported.add(m[1]);
  for (const m of code.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) imported.add(m[1]);
  for (const m of code.matchAll(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) imported.add(m[1]);

  // Every identifier the file REFERENCES, not just the two shapes checked first.
  //
  // It began here, matching only `instanceof X` and `new X`, because those were the
  // two that had actually bitten: a missing ApiError in orders.js. Then `qs` was
  // left un-imported in ui.js and every image-picker load threw a ReferenceError
  // that its own catch turned into an error state - a silent, entirely plausible
  // "no images found". `instanceof`/`new` did not match a bare `qs({...})` call, so
  // the check passed over the same defect it existed to prevent.
  //
  // So this takes the blunt approach: every bare identifier that is not declared
  // locally, imported, a JS global, or a property of something is reported. That
  // over-reports slightly (a name used only as an object key would be flagged) and
  // the cost of one extra name in a failure message is far below the cost of a
  // screen that silently shows nothing.
  const DECLARED = /(?:^|[^\w$.])(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of code.matchAll(DECLARED)) imported.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=]/)[0].trim();
      if (name) imported.add(name);
    }
  }
  // Destructured parameters: `const f = ({ a, b }) => {}` and `function f(a, b) {}`.
  for (const m of code.matchAll(/(?:function\s*[A-Za-z_$][\w$]*\s*|\))\s*\(\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=]/)[0].trim();
      if (name) imported.add(name);
    }
  }

  const used = new Set();
  for (const m of code.matchAll(/instanceof\s+([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  for (const m of code.matchAll(/\bnew\s+([A-Z][\w$]*)/g)) used.add(m[1]);
  // Bare CALLS and bare reads: `name(` or `name)`. The leading dot check is what
  // keeps `foo.bar(` and `this.name` out - a property is not an unresolved binding.
  for (const m of code.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*[(]/g)) used.add(m[2]);

  // Only names a sibling module actually exports are considered, so this can never
  // report a keyword, a local or a parameter - the noise that made the first
  // version of this check useless.
  const missing = [...used].filter((name) => moduleExports.has(name) && !imported.has(name));
  ok(`${file} imports every sibling-module helper it uses`,
    missing.length === 0, `used without importing: ${missing.join(", ")}`);
}

/* ---- the uploader's file naming rule ---- */

// 2. shrink() re-encodes every image to JPEG, but the uploader used to keep the
// ORIGINAL filename extension. A PNG therefore arrived as "photo.png" with type
// "image/jpeg", and the server's prepareUpload - which compares the two - refused
// it with "Type and extension disagree". Every non-JPEG upload failed, silently,
// because the rejection was re-thrown into the file input's change listener where
// nothing was listening.
//
// The rule is therefore: the extension is derived from the MIME type that was
// PRODUCED. This asserts the same rule the server applies.
const SERVER_ALLOWED_TYPES = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/avif": "avif", "image/gif": "gif",
};
const EXTENSION_FOR_TYPE = JSON.parse(
  /const EXTENSION_FOR_TYPE = (\{[\s\S]*?\n\});/.exec(
    readFileSync(join(siteRoot, "shared", "scripts", "admin", "ui.js"), "utf8"),
  )[1].replace(/,(\s*[}\]])/g, "$1"),
);

for (const [type, expectedExtension] of Object.entries(SERVER_ALLOWED_TYPES)) {
  ok(`uploader names a produced ${type} as .${expectedExtension}, which the server accepts`,
    EXTENSION_FOR_TYPE[type] === expectedExtension,
    `got ${EXTENSION_FOR_TYPE[type]}`);
}
ok("the uploader's table covers every type the server accepts",
  Object.keys(SERVER_ALLOWED_TYPES).every((type) => EXTENSION_FOR_TYPE[type] !== undefined),
  `missing: ${Object.keys(SERVER_ALLOWED_TYPES).filter((t) => EXTENSION_FOR_TYPE[t] === undefined).join(", ")}`);

const uiSource = readFileSync(join(siteRoot, "shared", "scripts", "admin", "ui.js"), "utf8");
ok("the uploader derives the extension from the produced type, not the incoming filename",
  !/file\.name\.split\("\."\)\.pop\(\)/.test(uiSource),
  "the original filename is still consulted for the extension");
ok("a failed upload is reported rather than re-thrown into nothing",
  /catch\s*\(err\)/.test(uiSource) && !/\.catch\(\(err\)\s*=>\s*\{[^}]*throw err/.test(uiSource),
  "an upload rejection can still escape the change listener unhandled");

/* ---- live search keeps focus, caret and the element itself ---- */

// The bug this pins: typing in a search box lost focus after every pause.
//
// It was not the debounce. The views built the WHOLE screen - search box, filters,
// table, pagination - inside one render(), and load() replaced everything with a
// spinner first. So each character caused a brand new <input> to replace the one
// being typed into, and the caret vanished. Search looked live and was unusable.
//
// These drive the real modules through the real event path. Nothing here asserts
// on a stub: if the scaffold stops being persistent, these fail.

const { adminSearch, adminFilters, listScaffold } = await import("../shared/scripts/admin/ui.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function typeInto(input, text) {
  input.value = text;
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

// Type a word one character at a time, as a person does, letting each pause fire
// its request and its re-render.
{
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const ui = listScaffold(host);

  const sent = [];
  mount(ui.controls, adminSearch({ placeholder: "Search", onSearch: (v) => sent.push(v) }));

  const input = ui.controls.querySelector("input");
  input.focus();
  ok("the search box can take focus", dom.window.document.activeElement === input);

  // Deliberately a pause between EVERY character (340ms > the 300ms debounce).
  // That is a person thinking between letters, so each one legitimately searches.
  // The point of this block is not how many requests fire - it is that focus, caret
  // and the element itself all survive that firing. The block below covers the
  // opposite case, where typing fast must produce ONE request.
  for (const char of "chioma") {
    typeInto(input, input.value + char);
    await sleep(340);
    ui.results(el("div", { class: "row", text: `results for ${input.value}` }));
  }

  ok("focus survives a full round of search-and-rerender", dom.window.document.activeElement === input,
    "activeElement moved off the search box");
  ok("the caret is still in the typed term", input.selectionStart === "chioma".length,
    `selectionStart was ${input.selectionStart}, expected ${"chioma".length}`);
  ok("the typed text is intact", input.value === "chioma", `got "${input.value}"`);
  ok("the box is the SAME element, not a replacement", ui.controls.querySelector("input") === input,
    "the input was replaced by a new one");
  // Each character was a separate pause, so each one searched - that is correct for
  // someone typing slowly. What matters is that the final term is right.
  ok("every pause searched the full term it was given",
    sent.length === 5 && sent[4] === "chioma", `sent: ${JSON.stringify(sent)}`);
}

// One request per pause: typing fast must not fire six searches.
{
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const ui = listScaffold(host);
  const sent = [];
  mount(ui.controls, adminSearch({ placeholder: "Search", onSearch: (v) => sent.push(v) }));
  const input = ui.controls.querySelector("input");

  for (const char of "sparkler") typeInto(input, input.value + char);
  await sleep(360);
  ok("seven fast keystrokes produce one request", sent.length === 1 && sent[0] === "sparkler",
    `sent: ${JSON.stringify(sent)}`);
}

// The floor: a single character must not hit the database.
{
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const ui = listScaffold(host);
  const sent = [];
  mount(ui.controls, adminSearch({ placeholder: "Search", onSearch: (v) => sent.push(v) }));
  const input = ui.controls.querySelector("input");

  typeInto(input, "c");
  await sleep(360);
  ok("a one-character term makes no request", sent.length === 0, `sent: ${JSON.stringify(sent)}`);
  ok("and says why", /2 characters/.test(ui.controls.textContent),
    `status read: "${ui.controls.textContent.trim()}"`);

  typeInto(input, "ch");
  await sleep(360);
  ok("reaching the floor searches", sent.length === 1 && sent[0] === "ch", `sent: ${JSON.stringify(sent)}`);
}

// A superseded search must not overwrite a newer one.
{
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const ui = listScaffold(host);

  // The first request is slow and the second is fast, so without cancellation the
  // stale answer would land last and win.
  const slow = ui.load((signal) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ term: "old" }), 120);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(null); });
  }), { pending: "Searching…" });

  await sleep(20);
  const fast = ui.load(async () => ({ term: "new" }), { pending: "Searching…" });

  const [first, second] = await Promise.all([slow, fast]);
  ok("a cancelled search reports no data instead of stale data",
    first === null && second !== null && second.term === "new",
    `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  // `ui.results` is the METHOD that fills the results half, so the node itself is
  // reached through `host` - which is where the scaffold mounted both halves.
  const resultsNode = host.querySelector(".list-results");
  ok("the pending indicator is cleaned up after the race",
    resultsNode.querySelectorAll(".list-pending").length === 0,
    `${resultsNode.querySelectorAll(".list-pending").length} still present`);
  ok("the loading state is cleared", !resultsNode.classList.contains("is-loading"));
}

// Enter searches at once; Escape returns to the unfiltered list.
{
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const ui = listScaffold(host);
  const sent = [];
  mount(ui.controls, adminSearch({ placeholder: "Search", onSearch: (v) => sent.push(v) }));
  const input = ui.controls.querySelector("input");

  typeInto(input, "glow");
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ok("Enter searches without waiting out the pause", sent.length === 1 && sent[0] === "glow",
    `sent: ${JSON.stringify(sent)}`);

  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok("Escape clears the box and the filter", input.value === "" && sent[sent.length - 1] === "",
    `value="${input.value}" sent: ${JSON.stringify(sent)}`);
}

// The controls must survive repeated re-renders of the results.
{
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const ui = listScaffold(host);
  const before = ui.controls;
  mount(ui.controls, adminSearch({ placeholder: "Search", onSearch: () => {} }));
  const input = ui.controls.querySelector("input");
  input.focus();
  for (let i = 0; i < 3; i++) {
    ui.results(el("div", { text: `page ${i}` }));
    await sleep(10);
  }
  ok("the controls container itself is never re-parented", ui.controls === before);
  ok("and focus is untouched by repeated result renders", dom.window.document.activeElement === input);
}

// A filter bar that resets its siblings on every pick is not a filter bar. The
// controls are built once (see above), so each change used to spread the
// BUILD-TIME snapshot - dropping every filter the operator had already chosen
// from the request while the other selects kept displaying them. Orders and
// Products have multiple filters and lost one per additional pick; this drives
// the primitive through the real event path and asserts on the payloads.
{
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);

  const sent = [];
  const bar = adminFilters({
    value: {},
    filters: [
      { key: "status", label: "Status", options: [{ value: "delivered", label: "Delivered" }] },
      { key: "payment", label: "Payment", options: [{ value: "cod", label: "Pay on delivery" }] },
    ],
    onChange: (next) => sent.push(next),
  });
  host.append(bar);

  const [statusSelect, paymentSelect] = bar.querySelectorAll("select");

  statusSelect.value = "delivered";
  statusSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  ok("picking a filter reports it to the screen",
    sent.length === 1 && sent[0].status === "delivered", JSON.stringify(sent));

  paymentSelect.value = "cod";
  paymentSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  ok("a second pick keeps the first filter instead of resetting it",
    sent.length === 2 && sent[1].status === "delivered" && sent[1].payment === "cod",
    `second payload: ${JSON.stringify(sent[1])}`);

  // "Clear filters" only counts if the bar looks cleared too.
  const clear = [...bar.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Clear filters");
  ok("the clear-filters button appears once a filter is chosen", Boolean(clear) && !clear.hidden);
  clear?.click();
  ok("clearing reports empty filters",
    sent.length === 3 && Object.keys(sent[2]).length === 0, JSON.stringify(sent[2]));
  ok("clearing resets the selects so the bar tells the truth",
    statusSelect.value === "" && paymentSelect.value === "");
}

// The primitive is only half the guarantee. A view can still defeat it by building
// its own controls inside render() instead of once at setup - which is precisely
// what every one of these views used to do. So this checks the CALL SITES, not the
// primitive: adminSearch/adminFilters must appear in the view's setup function and
// nowhere near a render().
//
// This is the check that would have caught the original bug, because that bug was
// never in adminSearch - it was in the views' habit of rebuilding everything.
{
  const searchViews = ["categories.js", "products.js", "media.js", "orders.js"];
  for (const file of searchViews) {
    const source = readFileSync(join(siteRoot, "shared", "scripts", "admin", "views", file), "utf8");

    // Every `function render(...) { ... }` body, matched by brace counting rather
    // than a regex, so a nested block does not end it early.
    const renderBodies = [];
    const header = /(?:async\s+)?function\s+render\s*\([^)]*\)\s*\{/g;
    for (const match of source.matchAll(header)) {
      let depth = 1;
      let index = match.index + match[0].length;
      while (index < source.length && depth > 0) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}") depth--;
        index++;
      }
      renderBodies.push(source.slice(match.index + match[0].length, index - 1));
    }

    const rebuiltInRender = renderBodies.some((body) => /adminSearch\(|adminFilters\(/.test(body));
    ok(`${file} does not build its controls inside render()`, !rebuiltInRender,
      "the search box is rebuilt on every result, which is what steals focus");

    ok(`${file} uses the persistent scaffold`, /listScaffold\(/.test(source),
      "no listScaffold call, so the controls are re-parented on every load");

    // Declaring `let ui` is not the same as assigning it. A view that declares it
    // and forgets to call listScaffold in start() compiles, renders nothing, and
    // fails only when a response arrives - which is why it reached a commit broken.
    ok(`${file} assigns the scaffold it declares`,
      !/let ui\s*;/.test(source) || /ui = listScaffold\(/.test(source),
      "`let ui` is declared but never assigned, so ui.load/ui.results throw on first use");
  }
}

/* ---- the image picker: reuse, bounds, and no second route to the same thing ---- */

// The bug these pin: uploading worked and REUSING did not. Every field that wanted
// an image had one way in - upload a new file - so a good shot already in the
// library could never be pointed at again. The library filled with near-duplicates
// and the originals sat unreferenced forever.

{
  const { adminImagePicker, imageBase } = await import("../shared/scripts/admin/ui.js");
  ok("the picker returns a button, like the uploader does - it does not open itself",
    adminImagePicker({ label: "x", onSelect: () => {} }).tagName === "BUTTON");
  ok("imageBase points at the same delivery host the media screen uses",
    typeof imageBase() === "string" && imageBase().length > 0);
}

for (const [file, subject] of [
  ["products.js", "product images"],
  ["testimonials.js", "testimonial screenshots"],
  ["categories.js", "category images"],
]) {
  const source = readFileSync(join(siteRoot, "shared", "scripts", "admin", "views", file), "utf8");
  ok(`${file} offers reuse for ${subject}`, /adminImagePicker\(/.test(source),
    "no picker on this screen, so an uploaded image can only be re-uploaded");
  ok(`${file} still offers upload for ${subject}`, /adminImageUploader\(/.test(source),
    "reuse replaced upload rather than joining it");
}

// The uploader's resize measure must not have been touched to make the picker work.
// MAX_EDGE/quality are what keeps an upload small on a poor connection, so a second
// path into the library with different numbers would undo that silently.
{
  const source = readFileSync(join(siteRoot, "shared", "scripts", "admin", "ui.js"), "utf8");
  ok("the resize measure is unchanged: one MAX_EDGE, one quality, one shrink()",
    (source.match(/const MAX_EDGE = 1400;/g) || []).length === 1
      && (source.match(/const JPEG_QUALITY = 0\.82;/g) || []).length === 1
      && (source.match(/async function shrink\(/g) || []).length === 1,
    "the picker's uploads must go through the same shrink as every other upload");
}

// Categories is the case that could not work at all: the list showed Set/None for
// an image, the column existed and the server accepted it, and no form ever sent it.
{
  const source = readFileSync(join(siteRoot, "shared", "scripts", "admin", "views", "categories.js"), "utf8");
  ok("the category form sends mediaR2Key on save", /mediaR2Key,/.test(source),
    "the image can be chosen but never persisted");
  ok("and clearing it sends an empty key rather than omitting it",
    /let mediaR2Key = category\.mediaR2Key \|\| ""/.test(source));
}

// The filter no-op lives in exactly one place: the primitive's own ""/All option.
// A view seeding `filter: "all"` reads as an APPLIED filter (the backend accepts
// "all", so nothing errors and the list looks right) - which still shows "Clear
// filters" on a list nothing is filtered, and clicking it re-sends the same query.
{
  const files = [
    join(siteRoot, "shared", "scripts", "admin", "ui.js"),
    ...["categories.js", "media.js", "orders.js", "products.js"]
      .map((name) => join(siteRoot, "shared", "scripts", "admin", "views", name)),
  ];
  const offenders = files.filter((file) => /filter: "all"/.test(readFileSync(file, "utf8")));
  ok("no view seeds its filter state with the backend's explicit no-op value",
    offenders.length === 0,
    `filter: "all" in: ${offenders.map((file) => file.split(/[\\/]/).pop()).join(", ")}`);
}

// Phase 2: the delivery URL builder and the alpha decision rule.
//
// Both are pure functions with no DOM dependency, which is what lets them be tested
// at all - and tested as the exact code the Pages build and the browser will run.

import {
  imageUrl, srcsetFor, imgAttrs, intrinsicWidthFor,
  DEFAULT_WIDTHS, DEFAULT_SIZES,
} from "../shared/scripts/imageUrls.js";

ok("a transform URL carries width, quality, format=auto and scale-down", () => {
  const url = imageUrl({ key: "uploads/a.jpg", width: 480, quality: 80, mode: "transform", deliveryBase: "/media" });
  assertMatch(url, /^\/media\/cdn-cgi\/image\/width=480,quality=80,format=auto,fit=scale-down\/uploads\/a\.jpg$/);
});

ok("no transform URL ever sharpens or adjusts colour", () => {
  // These are how a delivered image comes back looking processed rather than sharp.
  const url = imageUrl({ key: "uploads/a.jpg", width: 800, quality: 80, mode: "transform", deliveryBase: "/media" });
  for (const forbidden of ["sharpen", "blur", "gamma", "brightness", "contrast"]) {
    ok(`${forbidden} is not in the transform options`, !url.includes(forbidden));
  }
});

ok("a derivative URL points straight at a pre-rendered object, with no cdn-cgi", () => {
  const url = imageUrl({
    key: "uploads/a.jpg", width: 480, quality: 80,
    mode: "derivative", deliveryBase: "https://media.example.com",
  });
  assertMatch(url, /^https:\/\/media\.example\.com\/uploads\/a\.w480\.jpg$/);
  ok("derivative mode uses no transformation at all", !url.includes("cdn-cgi"));
});

ok("the width is part of the derivative KEY, so every candidate is its own cacheable object", () => {
  const narrow = imageUrl({ key: "uploads/a.jpg", width: 320, quality: 75, mode: "derivative", deliveryBase: "/media" });
  const wide = imageUrl({ key: "uploads/a.jpg", width: 960, quality: 75, mode: "derivative", deliveryBase: "/media" });
  ok("the two widths are different URLs", narrow !== wide);
  assertMatch(narrow, /\.w320\.jpg$/);
  assertMatch(wide, /\.w960\.jpg$/);
});

ok("each slot offers exactly the widths it is configured with", () => {
  for (const [slot, widths] of Object.entries(DEFAULT_WIDTHS)) {
    const srcset = srcsetFor({ key: "uploads/a.jpg", slot, mode: "transform", deliveryBase: "/media" });
    const offered = srcset.split(", ").map((part) => Number(part.trim().split(" ").pop().replace("w", "")));
    ok(`${slot} offers ${widths.join("/")}`,
      JSON.stringify(offered) === JSON.stringify(widths), `got ${offered.join("/")}`);
  }
});

ok("no slot offers more than three widths", () => {
  // Seven widths per slot was the thing being removed: each extra one is a
  // transformation nobody displays and a candidate the browser might pick wrongly.
  for (const [slot, widths] of Object.entries(DEFAULT_WIDTHS)) {
    ok(`${slot} has at most 3 widths`, widths.length <= 3, `got ${widths.length}`);
  }
});

ok("an empty key yields no URL and no srcset, rather than a broken path", () => {
  for (const key of ["", null, undefined]) {
    ok(`imageUrl(${JSON.stringify(key)}) is empty`, imageUrl({ key, width: 480, quality: 80 }) === "");
    ok(`srcsetFor(${JSON.stringify(key)}) is empty`, srcsetFor({ key, slot: "hero" }) === "");
  }
});

ok("an absolute key is used as-is, so a real CDN asset is never rewritten", () => {
  const absolute = "https://cdn.example.com/promo/hero.jpg";
  ok("transform mode leaves it alone", imageUrl({ key: absolute, width: 480, quality: 80, mode: "transform" }) === absolute);
  ok("derivative mode leaves it alone", imageUrl({ key: absolute, width: 480, quality: 80, mode: "derivative" }) === absolute);
});

ok("a trailing slash on the delivery base never doubles up", () => {
  const url = imageUrl({
    key: "uploads/a.jpg", width: 480, quality: 80,
    mode: "transform", deliveryBase: "https://media.example.com/",
  });
  assertMatch(url, /^https:\/\/media\.example\.com\/cdn-cgi\//);
  ok("no double slash", !url.includes(".com//"));
});

ok("every slot has a sizes attribute, because a missing one is a wrong candidate", () => {
  for (const slot of Object.keys(DEFAULT_WIDTHS)) {
    ok(`${slot} has sizes`, typeof DEFAULT_SIZES[slot] === "string" && DEFAULT_SIZES[slot].length > 0);
  }
  ok("the hero sizes matches the layout's own 768px breakpoint",
    DEFAULT_SIZES.hero.includes("768px"), `hero sizes is "${DEFAULT_SIZES.hero}"`);
});

ok("the width/height attributes use the largest width actually served", () => {
  // Reserving space for a width that is never delivered still reserves wrong space.
  ok("hero reports 1200", intrinsicWidthFor("hero") === 1200);
  ok("thumbnail reports 320", intrinsicWidthFor("thumbnail") === 320);
});

ok("imgAttrs emits src, srcset, sizes, width and height together", () => {
  const attrs = imgAttrs({ key: "uploads/a.jpg", slot: "hero", width: 1200, height: 900, alt: "Glow serum" });
  for (const name of ["src", "srcset", "sizes", "width", "height", "alt"]) {
    ok(`${name} is present`, attrs[name] !== undefined && attrs[name] !== "");
  }
  ok("alt is passed through untouched", attrs.alt === "Glow serum");
});

/* ---- the alpha decision, and the requirement that it changes nothing else ---- */

{
  const { planImageOutput } = await import("../shared/scripts/admin/ui.js");

  ok("an opaque image still goes out as JPEG at 0.82 - byte-identical to before", () => {
    const opaque = planImageOutput({ hasAlpha: false });
    ok("still JPEG", opaque.type === "image/jpeg");
    ok("still .jpg", opaque.extension === "jpg");
    ok("still quality 0.82", opaque.quality === 0.82, `got ${opaque.quality}`);
  });

  ok("an image with real transparency goes out as PNG", () => {
    const alpha = planImageOutput({ hasAlpha: true });
    ok("PNG, because transparency cannot survive JPEG", alpha.type === "image/png");
    ok("with a .png extension", alpha.extension === "png");
    ok("and no lossy quality, because PNG ignores it", alpha.quality === undefined);
  });

  ok("an unreadable alpha channel falls back to the old JPEG path, not to a guess", () => {
    // A tainted canvas cannot be read. Choosing PNG there would balloon every
    // product photo; guessing the other way would flatten a logo. Falling back to
    // the previous behaviour is the conservative answer.
    const refused = planImageOutput({ hasAlpha: null });
    ok("falls back to JPEG", refused.type === "image/jpeg");
    ok("at the original quality", refused.quality === 0.82);
  });

  ok("the alpha path is the ONLY difference - there is still exactly one shrink()", () => {
    const source = readFileSync(join(siteRoot, "shared", "scripts", "admin", "ui.js"), "utf8");
    const shrinks = source.match(/async function shrink\(/g) || [];
    ok("exactly one shrink()", shrinks.length === 1, `got ${shrinks.length}`);
    ok("and it resolves its output through planImageOutput",
      /canvas\.toBlob\(resolve, output\.type, output\.quality\)/.test(source));
  });

  ok("the content hash is computed in the browser, never in the Worker", () => {
    const source = readFileSync(join(siteRoot, "shared", "scripts", "admin", "ui.js"), "utf8");
    ok("uses SubtleCrypto", /crypto\?\.subtle/.test(source) || /crypto\.subtle/.test(source));
    ok("and tolerates its absence rather than failing the upload",
      /catch\s*\{\s*return null;/.test(source));
  });
}

/* ---- publish and deployment are reported as two separate facts ---- */

// The wording matters more than it looks. An operator told "publish failed" after a
// deploy failure would publish again, stacking a second snapshot over a perfectly
// good one, and would believe the site was broken when it was not.

{
  const source = readFileSync(join(siteRoot, "shared", "scripts", "admin", "views", "products.js"), "utf8");
  // Comments are stripped first. The rationale for NOT promising a time estimate is
  // itself written as a comment, so a raw scan fails on the very sentence explaining
  // the rule - which is a test that cannot distinguish the rule from its
  // explanation, and so proves nothing.
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const timePromise = /1\s*[-–]\s*3\s*min/i;

  ok("a failed REBUILD never says the publish failed", /Published\. Storefront rebuild FAILED\./.test(source));
  ok("a successful publish says the rebuild is in progress, with no time estimate",
    /Storefront rebuild in progress\./.test(source));
  ok("no unmeasured '1-3 minute' promise is quoted to an operator", !timePromise.test(noComments));
  ok("'triggered' is never shown raw next to a date",
    !/\(\$\{entry\.buildStatus\}\)/.test(source));
  ok("each status has a plain-English name",
    /describeBuildStatus/.test(source) && /rebuild requested/.test(source));
  ok("a rebuild retry reuses the existing snapshot rather than publishing again",
    /redeploy/.test(source) && /retryDeploy/.test(source));
  ok("the retry button only appears after a failed rebuild",
    /latestPublish\.buildStatus === "failed"/.test(source));
}

/* ---- the storefront deployment panel ---- */

// The panel's only job is to report what was OBSERVED. These pin the rules that stop
// it reporting anything else - most importantly that "LIVE" is never inferred from
// a successful publish, which is the exact bug this design was written to remove.

{
  const source = readFileSync(join(siteRoot, "shared", "scripts", "admin", "deployStatus.js"), "utf8");

  ok("the four states each have their own label", /LIVE ON STOREFRONT/.test(source)
    && /REBUILDING STOREFRONT/.test(source)
    && /STOREFRONT DEPLOYMENT FAILED/.test(source)
    && /PUBLISHED/.test(source));
  ok("states are distinguished by an icon as well as by colour", /STATE_ICON/.test(source),
    "colour alone is not an answer for an operator who cannot separate red from green");
  ok("the published and currently-live versions are shown side by side", /Published version/.test(source)
    && /Currently live/.test(source));
  ok("a stale live version is marked, not hidden", /is-stale/.test(source));
  ok("View Storefront opens the real page in a new tab", /View Storefront/.test(source)
    && /rel: "noopener noreferrer"/.test(source));
  ok("Retry is offered only where it helps", /status.state === "FAILED" && onRetry/.test(source));
  ok("an unconfigured SITE_URL is explained, never shown as a failure",
    /cannot be checked until SITE_URL is configured/.test(source));
  ok("no unmeasured time promise appears in the panel",
    // Comments are stripped for the same reason as the publish-outcome check: the
    // rationale for NOT promising a duration is itself a comment, and a raw scan
    // fails on the very sentence stating the rule.
    !/1\s*[-–]\s*3\s*min/i.test(
      source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")));
  ok("the panel is never handed its own idea of live - it only renders what it is given",
    !/buildStatus/.test(source), "the panel must read the observed status, not the stored attempt");
}

console.log(failures === 0 ? "\nADMIN UI CHECKS PASSED" : `\n${failures} ADMIN UI CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
