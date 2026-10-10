import { el, mount, formatNaira, formatDateTime, toWireTimestamp, humanStatus } from "../dom.js";
import { api, ApiError, qs } from "../api.js";
import { downloadXlsx } from "../xlsx.js";
import {
  adminTable, adminSearch, adminFilters, adminPagination, resultCount, adminField,
  fieldset, saveBar, readForm, applyFieldErrors, actionMenu, statusBadge, toast,
  toastError, openModal, confirmDialog, reasonDialog, definitionList, errorState, bulkBar,
  copyToClipboard, listScaffold,
} from "../ui.js";
import { markAsSpam, revertSpamFlag } from "./spam.js";
import { orderBadges, orderEvidenceSection } from "./evidence.js";

// Orders: the lightweight CRM.
//
// Two rules shape this whole file.
//
// First, the panel never decides what an operator may do. The API sends an `actions`
// array per row, computed server-side by orderCrmService from the order's actual
// state, and the row menu renders exactly that. The previous panel kept its own
// LEGAL_NEXT_STATUS table in the browser; that was a second copy of the rules, and
// the second copy is the one that drifts.
//
// Second, nothing here invents order state. delivered_at is set by the server in the
// same statement as the status, and a revert returns to the status implied by how
// the order was paid. The panel sends a verb and renders the answer.

const STATUSES = [
  { value: "awaiting_payment", label: "Awaiting payment" },
  { value: "paid", label: "Paid" },
  { value: "confirmed_cod", label: "Confirmed COD" },
  { value: "delivered", label: "Delivered" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "not_picking", label: "Not Picking" },
];

const ACTIONS = [
  { value: "deliver", label: "Mark delivered" },
  { value: "revert", label: "Revert delivery" },
  { value: "mark-paid", label: "Mark paid" },
  { value: "mark-failed", label: "Mark failed" },
  { value: "cancel", label: "Cancel" },
  { value: "revert-cancel", label: "Revert cancellation" },
  { value: "mark-not-picking", label: "Mark Not Picking" },
  { value: "revert-not-picking", label: "Revert Not Picking" },
];

// How each server action verb is worded, and how dangerous it is. The set of verbs
// is the server's; this only supplies the copy.
const ACTION_COPY = {
  deliver: { label: "Mark delivered", primary: true },
  revert: { label: "Revert to pending" },
  "mark-paid": { label: "Mark paid (override)", danger: true },
  "mark-failed": { label: "Mark failed (override)", danger: true },
  cancel: { label: "Cancel order", danger: true },
  "revert-cancel": { label: "Revert" },
  "mark-not-picking": { label: "Mark Not Picking", danger: true },
  "revert-not-picking": { label: "Revert" },
};

// Toolbar icons: light inline SVGs, built with createElementNS because the panel
// never assigns HTML (el() is textContent-only, so an SVG string would land as
// literal text). Static path data only - no interpolation - so there is nothing
// to escape. At <=900px the labels hide and these glyphs carry the buttons alone.
const SVG_NS = "http://www.w3.org/2000/svg";
function svgIcon(paths, { size = 16 } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// Feather-style glyphs: person (Assignment Mode), download (export), copy.
const ICON_PERSON = [
  "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
  "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
];
const ICON_DOWNLOAD = [
  "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
  "M7 10l5 5 5-5",
  "M12 15V3",
];
const ICON_COPY = [
  "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z",
  "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
];

export function ordersView({ shell, identity }) {
  const state = {
    page: 1, pageSize: 50, q: "", status: "", action: "", paymentMethod: "", from: "", to: "",
    // Assignment Mode (fulfilment routing). assignmentMode is the client toggle;
    // assignedTo filters to one staff member; deleted surfaces soft-deleted
    // orders (hidden from the normal list by the server).
    assignmentMode: false, assignedTo: "", deleted: "",
    selected: new Set(),
  };
  // Staff directory + whether the feature is enabled, loaded once. `staff` maps
  // email -> display name for the column and the picker; empty + disabled hides
  // every assignment control so the panel never offers what the server refuses.
  let staffList = [];
  let staffNames = new Map();
  let assignmentEnabled = false;
  // Staff loading is lazy + single-flight: nothing is fetched until the first
  // switch-ON, and a second click while the fetch is in flight awaits it rather
  // than starting another.
  let staffLoaded = false;
  let staffLoading = null;
  let myEmail = identity?.email || "";
  let tableHost;
  let assignHost;
  // Reveal/mode signature of the assignment controls; they are rebuilt only when
  // this changes, so an unrelated re-render never yanks focus from their selects.
  let controlsKey = null;
  let ui;

  const can = (permission) => (identity?.permissions || []).includes(permission);
  // Server flag AND the operator's own switch. Every assignment affordance -
  // column, menus, bulk action, staff filter, detail block - draws only while
  // BOTH hold, so flipping the switch off returns a plain orders list.
  const assignmentActive = () => assignmentEnabled && state.assignmentMode;

  async function load() {
    // The result set is about to be replaced, so the selection goes with it: a
    // selection that outlives a filter change would let a bulk action touch rows
    // the operator can no longer see.
    //
    // It lives HERE and not in render(): render also runs when a checkbox is
    // ticked, and clearing there wiped the selection that had just been made -
    // the box un-checked itself on the next frame and the bulk bar, gated on
    // state.selected.size, could never appear at all.
    state.selected.clear();
    try {
      // Assignment Mode is expressed as a server filter (unassigned=true) rather
      // than a client-side hide, so the count and the rows agree and the rule
      // lives in one place. A per-staff filter (assignedTo) and the deleted
      // filter ride along; all are absent when off, which means "no filter".
      const data = await ui.load((signal) => api.get(`/orders${qs({
        q: state.q, status: state.status, action: state.action, paymentMethod: state.paymentMethod,
        from: state.from, to: state.to, page: state.page, pageSize: state.pageSize,
        ...(state.assignmentMode && !state.assignedTo ? { unassigned: "true" } : {}),
        ...(state.assignedTo ? { assignedTo: state.assignedTo } : {}),
        ...(state.deleted ? { deleted: state.deleted } : {}),
      })}`, signal), { pending: "Loading orders…" });
      if (!data) return;
      // The feature flag rides the list response (env only, no extra query), so
      // the toolbar switch exists from the first paint; the staff directory is
      // fetched separately - only when the switch is first turned on.
      assignmentEnabled = data.assignmentEnabled === true;
      render(data);
    } catch (err) {
      ui.results(errorState(err, load));
    }
  }

  function checkbox(row) {
    return el("input", {
      type: "checkbox", "aria-label": `Select order ${row.reference}`,
      checked: state.selected.has(row.id),
      onchange: (event) => {
        if (event.target.checked) state.selected.add(row.id);
        else state.selected.delete(row.id);
        // Re-render rather than patch the bar in place: the bulk action set depends
        // on which rows are on screen, and a partial update is how a bar offers an
        // action for rows that are no longer there.
        render({ orders: lastOrders, page: lastPage });
      },
    });
  }
  /* ---- assignment (fulfilment routing) ----
   *
   * Every control here is hidden unless the server said the feature is enabled
   * (assignmentEnabled) AND the operator has orders:write. Assignment is not a
   * status: it only records who owns the order for fulfilment, never touching
   * payment, delivered_at or cancellation - the same separation the rest of the
   * panel keeps. */

  // The "Assigned to" cell: the owner as a quiet staff tag (hovering shows the
  // email), a muted "Not yet assigned", or a "Duplicate" tag on a duplicate
  // order (which does not count for the staff).
  function assignedCell(row) {
    if (row.possibleDuplicate) {
      return el("span", { class: "tag tag-duplicate", title: "Duplicate of an existing order - excluded from staff performance", text: "Duplicate" });
    }
    if (!row.assignedTo) {
      return el("span", { class: "muted", text: "Not yet assigned" });
    }
    const name = staffNames.get(row.assignedTo) || row.assignedTo;
    return el("span", { class: "tag tag-assigned", title: row.assignedTo, text: row.assignedTo === myEmail ? `${name} (you)` : name });
  }

  // The staff directory - fetched the FIRST time Assignment Mode is switched on
  // (single-flight, cached afterwards), so a visit with the mode off never pays
  // for it. Resolves true only when a usable directory arrived: an empty list is
  // the server's "feature off" response, and a failure keeps the mode off with a
  // toast rather than opening a picker the server would refuse.
  function ensureStaff() {
    if (staffLoaded) return Promise.resolve(staffList.length > 0);
    if (staffLoading) return staffLoading;
    staffLoading = api.get("/orders/staff")
      .then((data) => {
        staffList = data.staff || [];
        staffNames = new Map(staffList.map((s) => [s.email, s.name]));
        myEmail = data.me || myEmail;
        staffLoaded = true;
        return staffList.length > 0;
      })
      .catch(() => false)
      .finally(() => { staffLoading = null; });
    return staffLoading;
  }

  // The assign flow shared by the bulk bar, the row menu and the order modal:
  // ONE confirmation dialog - the count, a snapshot of exactly which orders are
  // involved, the staff picker and the confirm - so nobody approves a bulk
  // assignment they have not seen the scope of. The snapshot reads the rows
  // already on screen; the request carries only ids + the chosen email.
  async function assignRows(ids) {
    if (!assignmentActive() || ids.length === 0) return;
    const n = ids.length;
    const noun = n === 1 ? "order" : "orders";
    const snapshot = ids.map((id) => lastOrders.find((row) => row.id === id)).filter(Boolean);
    const shown = snapshot.slice(0, 10);
    const hidden = n - shown.length;
    let chosen = null;
    let term = "";
    let sending = false;

    const highlight = el("p", { class: "assign-confirm-highlight", text: `You are about to assign ${n} ${noun}.` });
    const confirmBtn = el("button", {
      class: "button button-primary", type: "button", text: "Assign",
      disabled: true, onclick: submit,
    });
    const pickerList = el("div", { class: "staff-picker-list" });

    // Picking a person arms the confirm (with their name on it); nothing is sent
    // until it is pressed. The chosen row is highlighted so the pick is visible.
    function drawPicker() {
      pickerList.replaceChildren();
      const q = term.trim().toLowerCase();
      const matches = staffList.filter((s) => !q || s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q));
      if (matches.length === 0) {
        mount(pickerList, el("p", { class: "muted", text: "No staff match that search." }));
        return;
      }
      for (const s of matches) {
        const isSelected = Boolean(chosen && chosen.email === s.email);
        mount(pickerList, el("button", {
          class: `staff-picker-item${isSelected ? " is-selected" : ""}`, type: "button",
          "aria-pressed": isSelected ? "true" : "false",
          onclick: () => {
            chosen = s;
            highlight.textContent = `You are about to assign ${n} ${noun} to ${s.name}.`;
            confirmBtn.disabled = false;
            confirmBtn.textContent = `Assign to ${s.name}`;
            drawPicker();
          },
        },
          el("span", { class: "strong", text: s.name }),
          el("span", { class: "muted mono", text: s.email })));
      }
    }

    async function submit() {
      if (!chosen || sending) return;
      sending = true;
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Assigning…";
      try {
        const result = await api.post("/orders/bulk-action", { ids, action: "assign", assignTo: chosen.email });
        modal.close();
        toast(`Assigned ${result.updated.length}, skipped ${result.skipped.length}, failed ${result.errors.length}`,
          result.errors.length || result.skipped.length ? "warn" : "success", 8000);
        for (const item of result.skipped.slice(0, 4)) toast(`Skipped ${item.reference}: ${item.reason}`, "warn");
        for (const item of result.errors.slice(0, 4)) toast(`Failed #${item.id}: ${item.reason}`, "error");
        load();
      } catch (err) {
        sending = false;
        confirmBtn.disabled = false;
        confirmBtn.textContent = `Assign to ${chosen.name}`;
        toastError(err);
      }
    }

    const modal = openModal({
      title: `Assign ${n} ${noun}`, width: "narrow",
      render: (close) => el("div", { class: "stack assign-dialog" },
        highlight,
        el("div", { class: "assign-snapshot" },
          el("span", { class: "filter-label", text: `Selected ${n} ${noun}` }),
          el("ul", {},
            shown.map((row) => el("li", { text: `${row.reference} · ${row.customerName}` })),
            hidden > 0 ? el("li", { class: "muted", text: `+${hidden} more not shown` }) : null)),
        el("div", { class: "staff-picker" },
          el("input", {
            class: "input", type: "search", "aria-label": "Search staff by name or email",
            placeholder: "Search staff by name or email",
            oninput: (e) => { term = e.target.value; drawPicker(); },
          }),
          pickerList),
        el("div", { class: "dialog-actions" },
          el("button", { class: "button", type: "button", text: "Cancel", onclick: close }),
          confirmBtn)),
    });
    drawPicker();
  }

  // The per-staff "Assigned to" filter + the deleted filter, drawn into the
  // controls host whenever the list renders. Assignment Mode itself lives in the
  // toolbar beside export (it is a view switch, not a filter value): the staff
  // filter belongs to that workspace and shows ONLY while the switch is on -
  // ticking a row does not reveal it. The deleted filter is ordinary order
  // management and stays either way.
  function renderAssignmentControls(host) {
    if (!assignmentEnabled) return;
    const revealed = state.assignmentMode;
    // Rebuild only when the visibility or the mode's wording actually changes:
    // an unrelated re-render would otherwise yank focus out of these selects.
    const key = String(revealed);
    if (key === controlsKey && host.childElementCount > 0) return;
    controlsKey = key;

    const staffFilter = el("label", { class: "filter" },
      el("span", { class: "filter-label", text: "Assigned to" }),
      el("select", {
        class: "input",
        onchange: (e) => { state.assignedTo = e.target.value; state.page = 1; load(); },
      },
        el("option", { value: "", text: state.assignmentMode ? "Unassigned" : "All orders" }),
        ...staffList.map((s) => el("option", { value: s.email, text: s.name, selected: state.assignedTo === s.email }))));

    const viewFilter = el("label", { class: "filter" },
      el("span", { class: "filter-label", text: "View" }),
      el("select", {
        class: "input",
        onchange: (e) => { state.deleted = e.target.value; state.page = 1; load(); },
      },
        el("option", { value: "", text: "Active", selected: state.deleted !== "true" }),
        el("option", { value: "true", text: "Deleted", selected: state.deleted === "true" })));

    // One mount of everything shown: mount() clears the host first, so mounting
    // them one at a time would drop the earlier ones.
    mount(host, ...(revealed ? [staffFilter] : []), viewFilter);
  }

  // The order-modal assignment block: who owns it (or "Not yet assigned"), who
  // set it and when, and the reversal control with its own confirmation. Separate
  // from the status history because assignment is not a status.
  function assignmentSection(order, assignments, close) {
    const latest = assignments.find((a) => a.action === "assign") || null;
    return el("div", { class: "detail-block" },
      el("h3", { class: "detail-heading", text: "Assignment" }),
      definitionList([
        ["Assigned to", order.assignedTo
          ? el("span", { class: "strong", text: staffNames.get(order.assignedTo) || order.assignedTo })
          : el("span", { class: "muted", text: "Not yet assigned" })],
        ["Set by", latest ? `${latest.actorEmail} · ${formatDateTime(latest.createdAt)}` : el("span", { class: "muted", text: "—" })],
      ]),
      el("div", { class: "detail-actions" },
        el("button", {
          class: "button button-small", type: "button",
          text: order.assignedTo ? "Reassign…" : "Assign to…",
          onclick: () => { close(); assignRows([order.id]); },
        }),
        order.assignedTo ? el("button", {
          class: "button button-small", type: "button", text: "Unassign",
          onclick: () => { close(); unassignRow(order); },
        }) : null));
  }

  // Unassign (the reversal) - an admin action, offered in the row menu and the
  // order modal. Never deletes anything; it only clears the owner.
  async function unassignRow(row) {
    const ok = await confirmDialog({
      title: `Unassign order ${row.reference}?`,
      confirmLabel: "Unassign",
      body: el("p", { class: "muted", text: "The order returns to the unassigned queue. Its status, payment and delivery are untouched, and the assignment history is kept." }),
    });
    if (!ok) return;
    try {
      await api.post(`/orders/${row.id}/unassign`, {});
      toast(`Order ${row.reference} unassigned`, "success");
      load();
    } catch (err) {
      toastError(err);
    }
  }



  let lastOrders = [];
  let lastPage = null;

  function render({ orders, page }) {
    lastOrders = orders;
    lastPage = page;

    // The export/copy targets: ticked rows win, otherwise the visible page.
    // lastOrders must be the source (never a re-fetch), because the loaded
    // page on screen IS the definition of "this page".
    const targetRows = () => (state.selected.size > 0
      ? lastOrders.filter((row) => state.selected.has(row.id))
      : lastOrders);
    const targetLabel = () => (state.selected.size > 0
      ? `${state.selected.size} selected order${state.selected.size === 1 ? "" : "s"}`
      : `the ${lastOrders.length} order${lastOrders.length === 1 ? "" : "s"} on this page`);

    ui.results(
      el("div", { class: "list-summary" },
        resultCount({ page, noun: "order" }),
        el("div", { class: "list-actions" },
          // Assignment Mode is a view switch, not a filter value, so it lives in
          // the toolbar beside export: gray pill with the knob left when off,
          // green with the knob rolled right when on.
          ...(assignmentEnabled ? [el("button", {
            class: `assignment-switch${state.assignmentMode ? " is-on" : ""}`,
            type: "button",
            role: "switch",
            "aria-checked": state.assignmentMode ? "true" : "false",
            "aria-label": "Assignment Mode",
            onclick: async () => {
              if (staffLoading) return; // one directory fetch at a time
              if (!state.assignmentMode) {
                // Lazy load: nothing was fetched while the mode was off, so the
                // first ON pulls the staff directory before the workspace opens.
                if (!(await ensureStaff())) {
                  toast("Assignment Mode is not available on this server", "warn");
                  return;
                }
                state.assignmentMode = true;
                // "Unassigned only" and one specific person are opposites: entering
                // the mode drops any per-staff filter, exactly as the old toggle did.
                if (state.assignedTo) state.assignedTo = "";
              } else {
                // Leaving the mode closes the whole workspace, and no invisible
                // per-staff filter may survive it.
                state.assignmentMode = false;
                state.assignedTo = "";
              }
              state.page = 1;
              load();
            },
          },
            el("span", { class: "assignment-switch-track" },
              el("span", { class: "assignment-switch-knob" })),
            el("span", { class: "assignment-switch-icon", "aria-hidden": "true" }, svgIcon(ICON_PERSON)),
            el("span", { class: "assignment-switch-label", text: "Assignment Mode" }))] : []),
          el("button", {
            class: "button button-small", type: "button",
            "aria-label": state.selected.size > 0 ? "Export selected (.xlsx)" : "Export page (.xlsx)",
            onclick: () => exportXlsx(targetRows(), `orders-${new Date().toISOString().slice(0, 10)}.xlsx`),
          },
            el("span", { class: "toolbar-icon" }, svgIcon(ICON_DOWNLOAD)),
            el("span", { class: "button-label", text: state.selected.size > 0 ? "Export selected (.xlsx)" : "Export page (.xlsx)" })),
          el("button", {
            class: "button button-small", type: "button",
            "aria-label": state.selected.size > 0 ? "Copy selected as text" : "Copy page as text",
            onclick: () => copyAsText(targetRows(), targetLabel()),
          },
            el("span", { class: "toolbar-icon" }, svgIcon(ICON_COPY)),
            el("span", { class: "button-label", text: state.selected.size > 0 ? "Copy selected as text" : "Copy page as text" })))),
      // The bulk bar rides directly under the toolbar, ABOVE the table: a
      // selection is acted on from the top of the screen, not after scrolling
      // past every row to the paginator (where it used to live).
      state.selected.size > 0 ? bulkBarFor([...state.selected]) : null,
      adminTable({
        caption: "Orders",
        rows: orders,
        rowKey: (row) => row.id,
        onRowClick: (row) => openDetail(row.id),
        // A flagged customer's rows are tinted very lightly. Deliberately quiet:
        // this is one flag among many rows, and a screen full of red would make the
        // operator stop noticing the thing they are looking for. The reason is not
        // here - it is on the order detail, where there is room to read it.
        rowClass: (row) => (row.spamFlagged ? "is-flagged" : ""),
        columns: [
          { label: "", className: "col-check", render: ({ row }) => checkbox(row) },
          { label: "Reference", className: "col-ref", render: ({ row }) => el("code", { class: "reference", text: row.reference }) },
          { label: "Placed", className: "col-when", render: ({ row }) => el("span", { class: "nowrap", text: formatDateTime(row.createdAt) }) },
          { label: "Customer", render: ({ row }) => el("div", { class: "stack" },
            el("span", { class: "strong", text: row.customerName }),
            el("span", { class: "muted mono", text: row.phone })) },
          { label: "Delivery", render: ({ row }) => el("div", { class: "stack" },
            el("span", { text: row.address }),
            el("span", { class: "muted", text: row.state })) },
          { label: "Item", render: ({ row }) => el("div", { class: "stack" },
            el("span", { text: row.productName || "—" }),
            el("span", { class: "muted", text: `×${row.quantity}` })) },
          { label: "Evidence", className: "col-evidence", render: ({ row }) => orderBadges(row) },
          { label: "Total", className: "col-num", render: ({ row }) => el("span", { class: "strong", text: formatNaira(row.amount) }) },
          { label: "Payment", render: ({ row }) => el("span", { class: "muted", text: row.paymentMethod === "cod" ? "COD" : "Prepaid" }) },
          { label: "Status", className: "col-status", render: ({ row }) => statusBadge(row.status, humanStatus(row.status)) },
          ...(assignmentActive() ? [{
            label: "Assigned to", className: "col-assigned",
            render: ({ row }) => assignedCell(row),
          }] : []),
          { label: "Actions", className: "col-actions", render: ({ row }) => actionMenu(rowMenuActions(row)) },
        ],
      }),
      adminPagination({
        page,
        onPage: (n) => { state.page = n; load(); },
        onPageSize: (n) => { state.pageSize = n; state.page = 1; load(); },
      }));

    if (assignHost) renderAssignmentControls(assignHost);
  }

  /* ---- row actions, driven entirely by the server ---- */

  function rowMenuActions(row) {
    const items = [
      { label: "View details", onSelect: () => openDetail(row.id) },
    ];
    if (can("orders:write")) {
      items.push({ label: "Edit details", onSelect: () => openEdit(row.id) });
      // Only offered when the server says the customer is not already flagged.
      // Flagging twice would be a 409, and offering an action that always fails is
      // how an operator learns to ignore error messages.
      if (!row.spamFlagged) {
        items.push({
          label: "Mark as spam",
          danger: true,
          onSelect: () => markAsSpam(row, () => load()),
        });
      }
    }
    // These come from order.actions. If the server did not offer it, it is not
    // rendered - which is the whole point of not keeping a copy of the rules here.
    for (const verb of row.actions || []) {
      if (verb === "revert" || verb === "revert-cancel" || verb === "revert-not-picking") continue;
      if (!can("orders:write")) continue;
      if ((verb === "mark-paid" || verb === "mark-failed") && !can("orders:payment-override")) continue;
      const copy = ACTION_COPY[verb];
      if (!copy) continue;
      items.push({ label: copy.label, danger: copy.danger, onSelect: () => runOrderAction(row, verb) });
    }
    items.push({ label: "Export order (.xlsx)", onSelect: () => exportXlsx([row], `order-${row.reference}.xlsx`) });
    items.push({ label: "Copy order as text", onSelect: () => copyAsText([row], "the order") });
    // Assignment controls, only when the feature is on and the operator may
    // write. "Assign to…" reassigns too (a person can be moved); "Unassign" is
    // the reversal and returns the order to the queue. Neither deletes anything.
    if (assignmentActive() && can("orders:write")) {
      items.push({ label: row.assignedTo ? "Reassign…" : "Assign to…", onSelect: () => assignRows([row.id]) });
      if (row.assignedTo) {
        items.push({ label: "Unassign", onSelect: () => unassignRow(row) });
      }
    }
    if (can("orders:delete")) {
      items.push({ label: "Delete order", danger: true, onSelect: () => removeOrder(row) });
    }
    return items;
  }

  /**
   * Sends one verb to its own endpoint. The payment overrides go to /mark-paid and
   * /mark-failed rather than through the legacy status route, because the server
   * treats them as explicit human overrides with their own permission and their own
   * audit entry - not as an ordinary CRM transition.
   */
  async function runOrderAction(row, verb) {
    // Cancel gets its own dialog rather than a yes/no confirm: a cancellation
    // without a recorded reason is unauditable, so the reason is collected here
    // and REQUIRED by the server as well. The request runs inside the dialog, so
    // the confirm button can show its in-flight state and a failure keeps the
    // typed text on screen for a retry.
    if (verb === "cancel") {
      const result = await reasonDialog({
        title: "Cancel this order?",
        danger: true,
        confirmLabel: "Cancel order",
        placeholder: "For example: customer asked to stop, duplicate order, wrong address…",
        body: el("div", {},
          el("p", { text: `Order ${row.reference} will be marked cancelled. Payment records are not changed and no refund is triggered.` }),
          el("p", { class: "muted", text: "The reason is stored in the order history. You can revert this cancellation from the order details." })),
        submit: (reason) => api.post(`/orders/${row.id}/cancel`, {
          expectedUpdatedAt: toWireTimestamp(row.updatedAt),
          reason,
        }),
      });
      if (result.ok) {
        toast(`Cancel order — ${row.reference}`, "success");
        load();
      } else if (result.conflict) {
        // Same words and the same reload as handleActionError's conflict branch,
        // said directly because there is no real ApiError instance to hand it.
        toast("This order changed while you were looking at it. Reloading the latest version.", "warn", 6000);
        load();
      }
      return;
    }
    if (["mark-paid", "mark-failed", "mark-not-picking", "revert-cancel", "revert-not-picking", "revert"].includes(verb)) {
      const titles = {
        "mark-paid": "Override this payment to paid?",
        "mark-failed": "Override this payment to failed?",
        "mark-not-picking": "Mark this order Not Picking?",
        "revert-cancel": "Revert this cancellation?",
        "revert-not-picking": "Revert Not Picking?",
        revert: "Revert delivery?",
      };
      const labels = {
        "mark-paid": "Mark paid",
        "mark-failed": "Mark failed",
        "mark-not-picking": "Mark Not Picking",
        "revert-cancel": "Revert",
        "revert-not-picking": "Revert",
        revert: "Revert delivery",
      };
      const isPaymentOverride = verb === "mark-paid" || verb === "mark-failed";
      const isReversal = verb.startsWith("revert");
      const ok = await confirmDialog({
        title: titles[verb],
        danger: !isReversal,
        confirmLabel: labels[verb],
        body: isPaymentOverride
          ? el("div", {},
            el("p", { text: `This records that YOU are asserting money ${verb === "mark-paid" ? "was" : "was not"} collected for order ${row.reference}.` }),
            el("p", { class: "muted", text: "The payment provider is not consulted. The history entry is recorded as an admin override, never as a webhook confirmation." }))
          : isReversal
            ? el("p", { text: `Order ${row.reference} will return to its status immediately before this action.` })
            : el("p", { text: `Order ${row.reference} will be marked ${verb === "cancel" ? "cancelled" : "Not Picking"}. You can revert this from the order details.` }),
      });
      if (!ok) return;
    }

    try {
      await api.post(`/orders/${row.id}/${verb}`, { expectedUpdatedAt: toWireTimestamp(row.updatedAt) });
      toast(`${ACTION_COPY[verb].label} — ${row.reference}`, "success");
      load();
    } catch (err) {
      handleActionError(err, load);
    }
  }

  /**
   * A lost update is its own case: the row moved under the operator, so the only
   * correct next step is to reload. Anything else would overwrite somebody else's
   * change, or leave the operator editing a version that no longer exists.
   */
  function handleActionError(err, reload) {
    if (err instanceof ApiError && err.isConflict) {
      toast("This order changed while you were looking at it. Reloading the latest version.", "warn", 6000);
      reload();
      return;
    }
    toastError(err);
  }

  async function removeOrder(row) {
    const ok = await confirmDialog({
      title: "Delete this order?",
      danger: true,
      requireText: "DELETE",
      confirmLabel: "Delete order",
      body: el("div", {},
        el("p", { text: `Order ${row.reference} will be removed along with its status history.` }),
        el("p", { class: "muted", text: "This cannot be undone. A paid or delivered order is refused by the server, because it is the record of a completed sale." })),
    });
    if (!ok) return;
    try {
      await api.del(`/orders/${row.id}`, { confirm: true });
      toast(`Order ${row.reference} deleted`, "success");
      load();
    } catch (err) {
      toastError(err);
    }
  }

  /* ---- bulk, in ONE request ---- */

  function bulkBarFor(ids) {
    const offer = (verb, label, danger) => ({ label, danger, onSelect: () => runBulk(ids, verb, label) });
    // Export/copy of the same selection lives beside the status actions: an
    // operator copying WhatsApp follow-ups for exactly the rows they ticked
    // should not have to un-check, copy the page, and re-check.
    const selectedRows = () => lastOrders.filter((row) => state.selected.has(row.id));
    return bulkBar({
      count: ids.length,
      onClear: () => { state.selected.clear(); render({ orders: lastOrders, page: lastPage }); },
      actions: [
        offer("deliver", "Mark delivered", false),
        offer("revert", "Revert delivery", false),
        ...(can("orders:payment-override")
          ? [offer("mark-paid", "Mark paid", true), offer("mark-failed", "Mark failed", true)]
          : []),
        // Same gate as the row menu: the feature on AND orders:write.
        ...(assignmentActive() && can("orders:write") ? [{ label: "Assign to…", onSelect: () => assignRows(ids) }] : []),
        { label: "Export (.xlsx)", onSelect: () => exportXlsx(selectedRows(), `orders-${new Date().toISOString().slice(0, 10)}.xlsx`) },
        { label: "Copy as text", onSelect: () => copyAsText(selectedRows(), `${ids.length} selected order${ids.length === 1 ? "" : "s"}`) },
      ],
    });
  }

  async function runBulk(ids, verb, label) {
    const ok = await confirmDialog({
      title: `${label} on ${ids.length} order${ids.length === 1 ? "" : "s"}?`,
      danger: verb.startsWith("mark-"),
      confirmLabel: label,
      body: el("p", { text: "One request is sent. Anything the server refuses is reported back to you rather than silently skipped." }),
    });
    if (!ok) return;

    try {
      const result = await api.post("/orders/bulk-action", { ids, action: verb });
      // The three counts are shown rather than collapsed into "done": a partial run
      // that reported plain success would leave the operator believing rows changed
      // that did not.
      toast(`${label}: ${result.updated.length} updated, ${result.skipped.length} skipped, ${result.errors.length} failed`,
        result.errors.length || result.skipped.length ? "warn" : "success", 8000);
      for (const item of result.skipped.slice(0, 4)) {
        toast(`Skipped ${item.reference}: ${item.reason}`, "warn");
      }
      for (const item of result.errors.slice(0, 4)) {
        toast(`Failed #${item.id}: ${item.reason}`, "error");
      }
      load();
    } catch (err) {
      toastError(err);
    }
  }

  /* ---- export: ONE column list, two outputs (file and clipboard) ---- */

  // This is the only definition of what an operator exports. The .xlsx download
  // and the tab-separated copy are two renderings of this list, which is the
  // only way they can stay in step; the old server-built CSV's twenty-one
  // columns (kobo amounts, slugs, internal ids) answered a different question
  // than the one asked here - "just the information I paste to a customer".
  //
  // Every cell is written as text on purpose: a phone number or a reference is
  // an identifier, and a spreadsheet that turns "08012345678" into 8012345678
  // hands back a number nobody can dial.
  const EXPORT_COLUMNS = [
    { header: "Order ID", value: (row) => row.reference },
    { header: "Date", value: (row) => formatDateTime(row.createdAt) },
    { header: "Name", value: (row) => row.customerName },
    { header: "Phone", value: (row) => row.phone },
    { header: "WhatsApp", value: (row) => row.whatsapp || row.phone || "" },
    { header: "Product / Qty", value: (row) => `${row.productName || "—"} ×${row.quantity ?? ""}` },
    { header: "Address", value: (row) => row.address ?? "" },
    { header: "Status", value: (row) => humanStatus(row.status) },
  ];

  function matrixFor(rows) {
    return [
      EXPORT_COLUMNS.map((column) => column.header),
      ...rows.map((row) => EXPORT_COLUMNS.map((column) => column.value(row))),
    ];
  }

  function exportXlsx(rows, filename) {
    if (!rows.length) {
      toast("Nothing to export — the list is empty", "warn");
      return;
    }
    downloadXlsx(filename, matrixFor(rows));
    toast(`Exported ${rows.length} order${rows.length === 1 ? "" : "s"} as ${filename}`, "success");
  }

  async function copyAsText(rows, what) {
    if (!rows.length) {
      toast("Nothing to copy — the list is empty", "warn");
      return;
    }
    // Tabs between cells, one order per line: pasted into WhatsApp it reads as
    // lines, pasted into a sheet it lands in columns. A tab or newline INSIDE a
    // cell would split the row, so they are flattened to spaces first.
    const text = matrixFor(rows)
      .map((cells) => cells.map((cell) => String(cell).replace(/[\t\r\n]+/g, " ")).join("\t"))
      .join("\n");
    const copied = await copyToClipboard(text);
    toast(copied ? `Copied ${what} as text` : `Could not copy ${what} — your browser blocked the clipboard`,
      copied ? "success" : "error");
  }

  /* ---- detail ---- */

  async function openDetail(id) {
    let data;
    try {
      data = await api.get(`/orders/${id}`);
    } catch (err) {
      toastError(err);
      return null;
    }
    const { order, history, spamFlag } = data;

    return openModal({
      title: `Order ${order.reference}`,
      render: (close) => el("div", { class: "detail" },
        el("div", { class: "detail-header" },
          statusBadge(order.status, humanStatus(order.status)),
          el("span", { class: "muted", text: `Placed ${formatDateTime(order.createdAt)}` })),

        definitionList([
          ["Customer", order.customerName],
          ["Phone", el("span", { class: "mono", text: order.phone })],
          ["WhatsApp", el("span", { class: "mono", text: order.whatsapp })],
          ["Address", el("div", { class: "stack" },
            el("span", { text: order.address }),
            el("span", { class: "muted", text: order.state }))],
          ["Notes from customer", order.questionNotes || el("span", { class: "muted", text: "None" })],
        ]),

        el("h3", { class: "detail-heading", text: "What was ordered" }),
        definitionList([
          ["Product", `${order.productName} (${order.productSlug})`],
          ["Quantity", String(order.quantity)],
          ["Unit price", formatNaira(order.unitPrice)],
          ["Discount", order.discountPercent > 0
            ? `${order.discountPercent}% (−${formatNaira(order.discountAmount)})`
            : "—"],
          ["Total paid", el("span", { class: "strong", text: formatNaira(order.amount) })],
          ["Payment method", order.paymentMethod === "cod" ? "Pay on delivery" : "Paid up front"],
          ["Delivered at", order.deliveredAt
            ? formatDateTime(order.deliveredAt)
            : el("span", { class: "muted", text: "Not delivered" })],
        ]),

        // The spam panel sits ABOVE the history, and only when a flag is active: an
        // unflagged order shows no section at all rather than an empty one.
        // Evidence first: whether this is a returning customer or a possible duplicate
        // is the first thing an operator needs to see on an order.
        orderEvidenceSection(data, { onChanged: () => { close(); load(); } }),

        // Assignment: current owner, who set it and when, and the reversal. Only
        // when the feature is enabled and the operator may write. The reversal is
        // here and NOT in the row dropdown on purpose - undoing an assignment is a
        // conscious act, exactly like reverting a cancellation.
        ...(assignmentActive() && can("orders:write") ? [assignmentSection(order, data.assignments || [], close)] : []),

        el("h3", { class: "detail-heading", text: "History" }),
        (history || []).length === 0
          ? el("p", { class: "muted", text: "No status changes recorded." })
          : el("ol", { class: "timeline" }, history.map((entry) => el("li", { class: "timeline-item" },
            el("div", { class: "timeline-head" },
              statusBadge(entry.newStatus, humanStatus(entry.newStatus)),
              el("span", { class: "muted", text: formatDateTime(entry.createdAt) })),
            // changedBy is the point of the trail: "webhook" and
            // "admin-override:someone@x" are different claims about who decided.
            el("p", { class: "timeline-meta" },
              el("span", { class: "strong", text: entry.changedBy }),
              entry.oldStatus ? el("span", { class: "muted", text: ` from ${humanStatus(entry.oldStatus)}` }) : null),
            entry.reason ? el("p", { class: "muted", text: entry.reason }) : null))),

        el("div", { class: "detail-actions" },
          can("orders:write")
            ? (order.actions || []).filter((verb) => verb === "revert" || verb === "revert-cancel" || verb === "revert-not-picking").map((verb) => el("button", {
            class: `button${ACTION_COPY[verb]?.danger ? " button-danger" : " button-primary"}`,
            type: "button", text: ACTION_COPY[verb]?.label || verb,
            onclick: async () => { close(); await runOrderAction(order, verb); },
            }))
            : [],
          el("button", { class: "button", type: "button", text: "Close", onclick: close }))),
    });
  }

  /* ---- edit: only the fields a delivery record may have corrected ---- */

  /**
   * The allowlist lives in the SCHEMA on the server, not here. This form cannot
   * offer a price, a quantity or a payment status because there is no input for one
   * - so "historical pricing is immutable" is a property of the wire format rather
   * than a promise this screen makes.
   */
  function openEdit(id) {
    const body = el("div", { class: "table-state" },
      el("div", { class: "spinner", "aria-hidden": "true" }),
      el("p", { class: "muted", text: "Loading order…" }));

    const modal = openModal({ title: "Edit delivery details", width: "narrow", render: () => body });

    api.get(`/orders/${id}`).then(({ order }) => {
      const form = el("form", { class: "form", onsubmit: (e) => e.preventDefault() },
        fieldset({ legend: "Customer", fields: [
          adminField({ name: "customerName", label: "Name", value: order.customerName }),
          adminField({ name: "phone", label: "Phone", value: order.phone }),
          adminField({ name: "whatsapp", label: "WhatsApp", value: order.whatsapp }),
        ] }),
        fieldset({ legend: "Delivery address", fields: [
          adminField({ name: "address", label: "Address", value: order.address, type: "textarea" }),
          adminField({ name: "state", label: "State", value: order.state, hint: "Must be a Nigerian state." }),
          adminField({ name: "questionNotes", label: "Customer notes", value: order.questionNotes || "", type: "textarea" }),
        ] }),
        el("p", { class: "form-note" },
          "Product, quantity, prices and payment status are not editable. They are what the customer agreed to, and changing them would rewrite financial history."),
        saveBar({
          saveLabel: "Save changes",
          onCancel: () => modal.close(),
          onSave: async () => {
            const values = readForm(form);
            try {
              await api.patch(`/orders/${id}`, {
                customerName: values.customerName,
                phone: values.phone,
                whatsapp: values.whatsapp,
                address: values.address,
                state: values.state,
                questionNotes: values.questionNotes || null,
                expectedUpdatedAt: toWireTimestamp(order.updatedAt),
              });
              toast("Order updated", "success");
              modal.close();
              load();
            } catch (err) {
              if (err instanceof ApiError && err.isValidation && err.fields) {
                // Each note goes beside its own field, so the operator is told which
                // box to fix rather than being handed a list.
                applyFieldErrors(form, err.fields);
                return;
              }
              handleActionError(err, load);
            }
          },
        }));
      mount(body, form);
    }).catch((err) => {
      mount(body, errorState(err, () => modal.close()));
    });

    return modal;
  }

  return {
    start() {
      tableHost = el("div", { class: "list" });
      mount(shell.content,
        el("div", { class: "list-panel" },
          el("div", { class: "list-head" },
            el("h2", { class: "list-title", text: "All orders" }),
            el("span", { class: "muted", text: "Search, filter, and act on delivery." })),
          tableHost));
      // Built once and never rebuilt: this is the fix for the search box losing
      // focus. It held the most controls of any screen - search, two filters and a
      // date range - so it lost the most on every keystroke.
      ui = listScaffold(tableHost);
      mount(ui.controls,
        adminSearch({
          value: state.q,
          placeholder: "Search reference, name, phone or status",
          onSearch: (value) => { state.q = value; state.page = 1; load(); },
        }),
        adminFilters({
          value: { status: state.status, action: state.action, paymentMethod: state.paymentMethod },
          filters: [
            { key: "status", label: "Status", options: STATUSES },
            { key: "action", label: "Available action", options: ACTIONS },
            { key: "paymentMethod", label: "Payment", options: [
              { value: "pay_now", label: "Paid up front" },
              { value: "cod", label: "Pay on delivery" },
            ] },
          ],
          onChange: (next) => {
            state.status = next.status || "";
            state.action = next.action || "";
            state.paymentMethod = next.paymentMethod || "";
            state.page = 1;
            load();
          },
        }),
        el("div", { class: "date-range" },
          el("label", { class: "filter" },
            el("span", { class: "filter-label", text: "From" }),
            el("input", {
              class: "input input-date", type: "date", value: state.from,
              onchange: (e) => { state.from = e.target.value; state.page = 1; load(); },
            })),
          el("label", { class: "filter" },
            el("span", { class: "filter-label", text: "To" }),
            el("input", {
              class: "input input-date", type: "date", value: state.to,
              onchange: (e) => { state.to = e.target.value; state.page = 1; load(); },
            }))));
      // Assignment controls live in their own host, appended AFTER the search,
      // filters and date range (mount() would clear them - it replaces children,
      // it does not add). Rendered after the staff directory loads, because
      // whether they exist at all depends on the server enabling the feature.
      assignHost = el("div", { class: "assignment-controls" });
      ui.controls.append(assignHost);
      // No staff fetch here: the directory is pulled on the first switch-ON
      // (ensureStaff), so a visit costs zero assignment round trips while the
      // mode is off. The deleted filter draws with the first render.
      load();
    },
  };
}
