import { el, mount, formatDateTime } from "../dom.js";
import { api } from "../api.js";
import { adminTable, errorState, listScaffold } from "../ui.js";

const MONTH_WINDOWS = [12, 24];
const count = (value) => Number(value || 0).toLocaleString();
const money = (kobo) => new Intl.NumberFormat("en-NG", {
  style: "currency", currency: "NGN", maximumFractionDigits: 0,
}).format(Number(kobo || 0) / 100);

function deliveryRate(row) {
  return row.totalValidOrders === 0
    ? "—"
    : `${((row.deliveredOrders / row.totalValidOrders) * 100).toFixed(1)}%`;
}

function snapshotLabel(row) {
  if (row.current) return "Live";
  const snapshot = row.snapshot;
  return snapshot
    ? `Snapshot taken ${formatDateTime(snapshot.takenAt)} (${snapshot.source})`
    : "Snapshot unavailable";
}

export function reportsView({ shell }) {
  const host = el("div");
  const ui = listScaffold(host);
  ui.controls.remove();
  let monthCount = 12;

  async function load() {
    mount(shell.toolbar,
      el("label", { class: "field-inline", for: "report-month-window" },
        el("span", { class: "muted", text: "Months" }),
        el("select", {
          class: "input", id: "report-month-window",
          onchange: (event) => { monthCount = Number(event.target.value); load(); },
        }, MONTH_WINDOWS.map((months) => el("option", {
          value: String(months),
          text: `Last ${months} months`,
          selected: months === monthCount,
        }))),
      ),
      el("button", {
        class: "button button-small", type: "button", text: "Refresh", onclick: load,
      }));
    try {
      const data = await ui.load(
        (signal) => api.get(`/reports/monthly-kpis?months=${monthCount}`, signal),
        { pending: "Loading monthly reports…" },
      );
      if (!data) return;
      render(data);
    } catch (err) {
      ui.results(errorState(err, load));
    }
  }

  function render(data) {
    const rows = data.reports || [];
    const current = rows.find((row) => row.current);
    ui.results(el("div", { class: "list-panel" },
      data.collectionAvailable
        ? null
        : el("div", { class: "notice notice-info" },
          el("p", { text: data.collectionUnavailableReason || "Collected cash is not reported." })),
      data.deliveryTimingNote
        ? el("p", { class: "muted", text: data.deliveryTimingNote })
        : null,
      current
        ? el("div", { class: "stat-row" },
          stat("Current delivery rate", deliveryRate(current)),
          stat("Non-spam orders", count(current.totalValidOrders)),
          stat("Delivered orders", count(current.deliveredOrders)))
        : null,
      el("h2", { class: "detail-heading", text: "Delivery performance" }),
      adminTable({
        caption: "Monthly delivery performance",
        rows,
        rowKey: (row) => row.month,
        columns: [
          { label: "Month", render: ({ row }) => row.month },
          { label: "Real, non-spam orders", className: "col-num", render: ({ row }) => count(row.totalValidOrders) },
          { label: "Delivered (same cohort)", className: "col-num", render: ({ row }) => count(row.deliveredOrders) },
          { label: "Delivery rate", className: "col-num", render: ({ row }) => deliveryRate(row) },
          { label: "Delivered order value", className: "col-num", render: ({ row }) => money(row.deliveredRevenue) },
          { label: "Delivered during month", className: "col-num", render: ({ row }) => count(row.deliveredInMonth) },
          { label: "Collected cash", render: ({ row }) => row.collectedAmount === null ? "Not reported" : money(row.collectedAmount) },
          { label: "Snapshot", render: ({ row }) => el("span", { class: "muted", text: snapshotLabel(row) }) },
        ],
      }),
      el("h2", { class: "detail-heading", text: "Order lifecycle and signals" }),
      adminTable({
        caption: "Monthly order lifecycle and signals",
        rows,
        rowKey: (row) => row.month,
        columns: [
          { label: "Month", render: ({ row }) => row.month },
          { label: "All orders", className: "col-num", render: ({ row }) => count(row.totalOrders) },
          { label: "Awaiting payment", className: "col-num", render: ({ row }) => count(row.awaitingPaymentOrders) },
          { label: "Failed", className: "col-num", render: ({ row }) => count(row.failedOrders) },
          { label: "Confirmed COD", className: "col-num", render: ({ row }) => count(row.confirmedCodOrders) },
          { label: "Paid", className: "col-num", render: ({ row }) => count(row.paidOrders) },
          { label: "Delivered (all)", className: "col-num", render: ({ row }) => count(row.deliveredStatusOrders) },
          { label: "Cancelled", className: "col-num", render: ({ row }) => count(row.cancelledOrders) },
          { label: "Not Picking", className: "col-num", render: ({ row }) => count(row.notPickingOrders) },
          { label: "Spam-flagged", className: "col-num", render: ({ row }) => count(row.spamFlaggedOrders) },
          { label: "Abuse evidence", className: "col-num", render: ({ row }) => count(row.abuseEvidenceOrders) },
          { label: "Pay now", className: "col-num", render: ({ row }) => count(row.payNowOrders) },
          { label: "COD", className: "col-num", render: ({ row }) => count(row.codOrders) },
        ],
      })));
  }

  function stat(label, value) {
    return el("div", { class: "stat" },
      el("span", { class: "stat-label", text: label }),
      el("span", { class: "stat-value", text: value }));
  }

  return {
    start() {
      mount(shell.content, host);
      load();
    },
  };
}
