import { el, mount, formatNaira, formatDateTime, toWireTimestamp, humanStatus } from "../dom.js";
import { api, ApiError, qs } from "../api.js";
import {
  adminTable, adminSearch, adminFilters, adminPagination, resultCount, adminField,
  fieldset, saveBar, readForm, applyFieldErrors, actionMenu, statusBadge, toast,
  toastError, openModal, confirmDialog, definitionList, errorState, bulkBar,
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
];

// How each server action verb is worded, and how dangerous it is. The set of verbs
// is the server's; this only supplies the copy.
const ACTION_COPY = {
  deliver: { label: "Mark delivered", primary: true },
  revert: { label: "Revert to pending" },
  "mark-paid": { label: "Mark paid (override)", danger: true },
  "mark-failed": { label: "Mark failed (override)", danger: true },
};

export function ordersView({ shell, identity }) {
  const state = {
    page: 1, pageSize: 50, q: "", status: "", paymentMethod: "", from: "", to: "",
    selected: new Set(),
  };
  let tableHost;
  let ui;

  const can = (permission) => (identity?.permissions || []).includes(permission);

  async function load() {
    try {
      const data = await ui.load((signal) => api.get(`/orders${qs({
        q: state.q, status: state.status, paymentMethod: state.paymentMethod,
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
    // A selection that outlives a filter change would let a bulk action touch rows
    // the operator can no longer see, so it is cleared whenever the result set does.
    state.selected.clear();

    ui.results(
      el("div", { class: "list-summary" },
        resultCount({ page, noun: "order" }),
        el("button", {
          class: "button button-small", type: "button", text: "Copy page as CSV",
          onclick: copyPageCsv,
        })),
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
      const copy = ACTION_COPY[verb];
      if (!copy) continue;
      items.push({ label: copy.label, danger: copy.danger, onSelect: () => runOrderAction(row, verb) });
    }
    items.push({ label: "Copy row as CSV", onSelect: () => copyRowsCsv([row]) });
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
    if (verb.startsWith("mark-")) {
      const ok = await confirmDialog({
        title: verb === "mark-paid" ? "Override this payment to paid?" : "Override this payment to failed?",
        danger: true,
        confirmLabel: verb === "mark-paid" ? "Mark paid" : "Mark failed",
        body: el("div", {},
          el("p", { text: `This records that YOU are asserting money ${verb === "mark-paid" ? "was" : "was not"} collected for order ${row.reference}.` }),
          el("p", { class: "muted", text: "The payment provider is not consulted. The history entry is recorded as an admin override, never as a webhook confirmation." })),
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
    return bulkBar({
      count: ids.length,
      onClear: () => { state.selected.clear(); render({ orders: lastOrders, page: lastPage }); },
      actions: [
        offer("deliver", "Mark delivered", false),
        offer("revert", "Revert delivery", false),
        ...(can("orders:payment-override")
          ? [offer("mark-paid", "Mark paid", true), offer("mark-failed", "Mark failed", true)]
          : []),
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

  /* ---- CSV ---- */

  /**
   * The CSV is built SERVER-SIDE and copied verbatim. Escaping quotes and commas in
   * two places - once here, once in the panel - is how an address silently splits
   * across two spreadsheet columns, so the panel only moves characters it was given.
   */
  async function copyPageCsv() {
    try {
      const { csv } = await api.get(`/orders/csv${qs({
        q: state.q, status: state.status, paymentMethod: state.paymentMethod,
        from: state.from, to: state.to, page: state.page, pageSize: state.pageSize,
      })}`);
      await copyCsv(csv, "this page");
    } catch (err) {
      toastError(err);
    }
  }

  async function copyRowsCsv(rows) {
    // One row still goes through the server so its escaping is identical to the page
    // export. A locally-built single row would be a second set of rules.
    try {
      const { csv } = await api.get(`/orders/csv${qs({ page: state.page, pageSize: 1000 })}`);
      const [header, ...lines] = csv.split("\r\n");
      const wanted = rows.map((row) => row.reference);
      const body = lines.filter((line) => wanted.some((ref) => line.includes(ref)));
      await copyCsv([header, ...body].join("\r\n"), rows.length === 1 ? "1 row" : `${rows.length} rows`);
    } catch (err) {
      toastError(err);
    }
  }

  async function copyCsv(csv, what) {
    const ok = await copyToClipboard(csv);
    toast(ok ? `Copied ${what} as CSV` : `Could not copy ${what} — your browser blocked the clipboard`,
      ok ? "success" : "error");
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
          (order.actions || []).map((verb) => el("button", {
            class: `button${ACTION_COPY[verb]?.danger ? " button-danger" : " button-primary"}`,
            type: "button", text: ACTION_COPY[verb]?.label || verb,
            onclick: async () => { close(); await runOrderAction(order, verb); },
          })),
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
          placeholder: "Search reference, name or phone",
          onSearch: (value) => { state.q = value; state.page = 1; load(); },
        }),
        adminFilters({
          value: { status: state.status, paymentMethod: state.paymentMethod },
          filters: [
            { key: "status", label: "Status", options: STATUSES },
            { key: "paymentMethod", label: "Payment", options: [
              { value: "pay_now", label: "Paid up front" },
              { value: "cod", label: "Pay on delivery" },
            ] },
          ],
          onChange: (next) => {
            state.status = next.status || "";
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
