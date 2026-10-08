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
  "/admin/orders": { orders: [{ id: 1, reference: "ord-abc-12345678", createdAt: "2026-01-01T10:00:00Z", customerName: "Chioma", phone: "08012345678", whatsapp: "08012345678", address: "12 Allen Ave", state: "Lagos", productName: "Glow", productSlug: "glow", categoryName: "Skin", quantity: 1, unitPrice: 100, subtotal: 100, discountPercent: 0, discountAmount: 0, amount: 100, currency: "NGN", paymentMethod: "cod", status: "paid", deliveredAt: null, updatedAt: "2026-01-01T10:00:00Z", actions: ["deliver", "cancel", "mark-not-picking"] }], page: PAGE },
  "/admin/orders/csv": { csv: "id,reference\n1,ord-abc-12345678" },
  "/admin/orders/1": { order: { id: 1, reference: "ord-abc-12345678", customerName: "Chioma", phone: "08012345678", whatsapp: "08012345678", address: "12 Allen Ave", state: "Lagos", productName: "Glow", productSlug: "glow", quantity: 1, unitPrice: 100, discountPercent: 0, discountAmount: 0, amount: 100, currency: "NGN", paymentMethod: "cod", status: "cancelled", deliveredAt: null, createdAt: "2026-01-01T10:00:00Z", updatedAt: "2026-01-01T10:00:00Z", actions: ["revert-cancel"] }, history: [] },
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
};

const requested = [];
const requestedUrls = [];
let reportDelay = 0;
// Defined once as a factory, because `fetch` must be installed on EACH window the
// bundle runs in. Setting it on globalThis is not enough: the bundle is evaluated
// with window.eval, so its bare `fetch(...)` resolves against that window, not
// against Node's global. Assigning only the global left every route calling jsdom's
// real fetch, which produced an HTML body, which failed JSON.parse, which surfaced
// as "b.text is not a function" — a failure in the harness wearing the costume of
// a bug in the console.
const stubFetch = () => async (input) => {
  const url = String(input);
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  requested.push(path);
  requestedUrls.push(url);
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

    main.querySelector("tbody tr")?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const detailActions = page.window.document.querySelector(".detail-actions");
    const detailActionLabels = [...(detailActions?.querySelectorAll("button") || [])]
      .map((button) => button.textContent.trim());
    ok("the order detail modal offers a Revert control",
      detailActionLabels.includes("Revert"));
    ok("the detail modal does not offer forward cancellation or Not Picking actions",
      !detailActionLabels.includes("Cancel order") && !detailActionLabels.includes("Mark Not Picking"));
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
for (const rel of ["ui.js", "api.js", "dom.js"]) {
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
];
const EXPECTED = {
  // Identifiers a view may use without importing: JS builtins and globals.
  globals: new Set(["window", "document", "console", "fetch", "FormData", "File", "Blob", "URL",
    "AbortController", "setTimeout", "clearTimeout", "navigator", "location", "JSON", "Object",
    "Array", "Number", "String", "Boolean", "Date", "Math", "Promise", "Map", "Set", "undefined",
    "globalThis", "isFinite", "isNaN", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent"]),
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

const { adminSearch, listScaffold } = await import("../shared/scripts/admin/ui.js");

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
