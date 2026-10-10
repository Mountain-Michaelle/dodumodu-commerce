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

export function ordersView({ shell, identity }) {
  const state = {
    page: 1, pageSize: 50, q: "", status: "", action: "", paymentMethod: "", from: "", to: "",
    selected: new Set(),
  };
  let tableHost;
  let ui;

  const can = (permission) => (identity?.permissions || []).includes(permission);

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
      const data = await ui.load((signal) => api.get(`/orders${qs({
        q: state.q, status: state.status, action: state.action, paymentMethod: state.paymentMethod,
        from: state.from, to: state.to, page: state.page, pageSize: state.pageSize,
      })}`, signal), { pending: "Loading orders…" });
      if (!data) return;
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
          el("button", {
            class: "button button-small", type: "button",
            text: state.selected.size > 0 ? "Export selected (.xlsx)" : "Export page (.xlsx)",
            onclick: () => exportXlsx(targetRows(), `orders-${new Date().toISOString().slice(0, 10)}.xlsx`),
          }),
          el("button", {
            class: "button button-small", type: "button",
            text: state.selected.size > 0 ? "Copy selected as text" : "Copy page as text",
            onclick: () => copyAsText(targetRows(), targetLabel()),
          }))),
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
          { label: "Actions", className: "col-actions", render: ({ row }) => actionMenu(rowMenuActions(row)) },
        ],
      }),
      adminPagination({
        page,
        onPage: (n) => { state.page = n; load(); },
        onPageSize: (n) => { state.pageSize = n; state.page = 1; load(); },
        extra: state.selected.size > 0 ? bulkBarFor([...state.selected]) : null,
      }));
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
      load();
    },
  };
}
