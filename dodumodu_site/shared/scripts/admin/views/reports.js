import { el, mount, formatDateTime } from "../dom.js";
import { api } from "../api.js";
import { adminTable, errorState, listScaffold } from "../ui.js";
import { lineChart, chartFigure } from "../chart.js";

const MONTH_WINDOWS = [12, 24];
// The visitor DAILY series is paged in fixed Lagos-day windows. "Last 10 days
// first" is the default page; Prev/Next shift the window, and an explicit date
// filter can jump anywhere (the backend caps the span at 93 days).
const VISIT_PAGE_DAYS = 10;
let visitPaging = false;
const lagosToday = () => new Date(Date.now() + 36e5).toISOString().slice(0, 10);
function shiftDay(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const count = (value) => Number(value || 0).toLocaleString();
const money = (kobo) => new Intl.NumberFormat("en-NG", {
  style: "currency", currency: "NGN", maximumFractionDigits: 0,
}).format(Number(kobo || 0) / 100);
const percent = (fraction) => `${(fraction * 100).toFixed(1)}%`;

// The repository's actual lifecycle statuses (order_status enum), mapped to the
// KPI field that counts each. This list is the source of truth for the side
// summary — it is NOT a hardcoded subset, and it is a separate metric from the
// delivery-rate line chart.
const LIFECYCLE_STATUSES = [
  { key: "awaitingPaymentOrders", label: "Awaiting payment" },
  { key: "failedOrders", label: "Failed" },
  { key: "confirmedCodOrders", label: "Confirmed COD" },
  { key: "paidOrders", label: "Paid" },
  { key: "deliveredStatusOrders", label: "Delivered" },
  { key: "notPickingOrders", label: "Not Picking" },
  { key: "cancelledOrders", label: "Cancelled" },
];

// delivery_rate = non_spam_real_delivered / non_spam_real_orders. Both sides come
// from the SAME cohort (deliveredOrders and totalValidOrders are both non-spam,
// real orders), so this is the approved rate and never a bare delivered count.
// Returns null for a zero denominator so the chart draws a gap, not a fake zero.
function deliveryRateFraction(row) {
  const denom = Number(row.totalValidOrders || 0);
  if (denom === 0) return null;
  return Number(row.deliveredOrders || 0) / denom;
}

function deliveryRate(row) {
  const fraction = deliveryRateFraction(row);
  return fraction === null ? "—" : percent(fraction);
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
  // Visitor daily window, as an explicit Lagos [from, to] range. Initialised to
  // the last VISIT_PAGE_DAYS days ending today, then moved by Prev/Next or an
  // explicit date filter. Sent to the API so the browser never holds more than
  // one page of daily rows.
  let visitTo = lagosToday();
  let visitFrom = shiftDay(visitTo, -(VISIT_PAGE_DAYS - 1));

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
      // Both reports are fetched in ONE ui.load call. ui.load keeps a single
      // in-flight request (a second call would abort the first), and the visitor
      // request is fail-open: its failure must never blank the KPI report.
      const data = await ui.load(
        async (signal) => {
          const kpis = await api.get(`/reports/monthly-kpis?months=${monthCount}`, signal);
          let visitors = null;
          try {
            visitors = await api.get(
              `/reports/visitors?from=${visitFrom}&to=${visitTo}`,
              signal,
            );
          } catch { visitors = null; }
          return { kpis, visitors };
        },
        { pending: "Loading monthly reports…" },
      );
      if (!data) return;
      render(data.kpis, data.visitors);
    } catch (err) {
      ui.results(errorState(err, load));
    }
  }

  function render(kpiData, visitorData) {
    const rows = kpiData.reports || [];
    const current = rows.find((row) => row.current);
    ui.results(el("div", { class: "list-panel report-panel" },
      kpiData.collectionAvailable
        ? null
        : el("div", { class: "notice notice-info" },
          el("p", { text: kpiData.collectionUnavailableReason || "Collected cash is not reported." })),
      kpiData.deliveryTimingNote
        ? el("p", { class: "muted", text: kpiData.deliveryTimingNote })
        : null,
      current
        ? el("div", { class: "stat-row" },
          stat("Current delivery rate", deliveryRate(current)),
          stat("Non-spam orders", count(current.totalValidOrders)),
          stat("Delivered orders", count(current.deliveredOrders)))
        : null,
      el("h2", { class: "detail-heading", text: "Delivery performance" }),
      el("div", { class: "report-grid" },
        chartFigure({
          title: "Delivered-order rate over time",
          subtitle: "Per Lagos month · delivered ÷ all non-spam orders",
          ariaLabel: "Delivered-order rate over time",
          chart: lineChart(rows.map((row) => ({
            label: row.month,
            value: deliveryRateFraction(row),
          })), {
            format: (value) => `${(value * 100).toFixed(1)}%`,
            yMax: 1,
            emptyText: "No delivery-rate data for this period yet.",
          }),
          caption: "Percent (0–100%). Cancelled, failed and awaiting-payment orders stay in the denominator; spam-marked orders are excluded from both sides.",
        }),
        lifecycleSummary(current || rows[rows.length - 1])),
      el("h3", { class: "detail-heading", text: "Monthly delivery performance" }),
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
      }),

      /* ---- Visitor analytics: a separate chart from the sales/delivery one ---- */
      visitorSection(visitorData)));
  }

  /* Side summary beside the delivery-rate chart: totals for every real lifecycle
     status for one month. Counts and monetary amounts are clearly separated, and
     order amount is NEVER presented as collected cash. */
  function lifecycleSummary(row) {
    if (!row) {
      return el("aside", { class: "report-side" },
        el("h3", { class: "detail-heading", text: "Order status totals" }),
        el("p", { class: "muted", text: "No month has orders yet." }));
    }
    return el("aside", { class: "report-side" },
      el("h3", { class: "detail-heading", text: `Order status totals — ${row.month}` }),
      el("ul", { class: "status-list" },
        LIFECYCLE_STATUSES.map((status) => el("li", { class: "status-item" },
          el("span", { class: "status-label", text: status.label }),
          el("span", { class: "status-count", text: count(row[status.key]) })))),
      el("dl", { class: "status-money" },
        el("dt", { text: "Delivered order value" }),
        el("dd", { text: money(row.deliveredRevenue) }),
        el("dt", { text: "Collected cash" }),
        el("dd", { text: row.collectedAmount === null ? "Not reported" : money(row.collectedAmount) })),
      el("p", { class: "muted", text: "Counts are orders per status. Delivered order value is not collected cash." }));
  }

  /* Visitor trend: daily distinct visitor-day records over time, plus the
     daily/monthly/yearly DISTINCT metrics. Monthly and yearly are distinct
     counts, never a sum of the daily series.

     The DAILY series is paged in Lagos-day windows and is the only thing the
     date filter touches; monthly/yearly are whole-period aggregates. Prev/Next
     shift the window by VISIT_PAGE_DAYS, Next is disabled once the window
     reaches today, and an explicit from/to filter jumps anywhere within the
     backend's 93-day cap. */
  function visitorSection(visitorData) {
    const daily = (visitorData && visitorData.daily) || [];
    const monthly = (visitorData && visitorData.monthly) || [];
    const yearly = (visitorData && visitorData.yearly) || [];
    const geography = (visitorData && visitorData.geography) || [];
    const today = (visitorData && visitorData.today) || lagosToday();
    const range = (visitorData && visitorData.dailyRange) || { from: visitFrom, to: visitTo };

    const page = (direction) => {
      if (visitPaging) return;
      visitPaging = true;
      const nextTo = direction < 0
        ? shiftDay(range.from, -1)
        : shiftDay(range.to, VISIT_PAGE_DAYS);
      // Never page into the future: clamp the window's end to today.
      const clampedTo = nextTo > today ? today : nextTo;
      visitTo = clampedTo;
      visitFrom = shiftDay(clampedTo, -(VISIT_PAGE_DAYS - 1));
      load();
      setTimeout(() => { visitPaging = false; }, 250);
    };
    const atLatest = visitTo >= today;
    const pageTotal = daily.reduce((sum, day) => sum + Number(day.visitors || 0), 0);

    return el("div", {},
      el("h2", { class: "detail-heading", text: "Visitor analytics" }),
      visitorData && visitorData.notice
        ? el("p", { class: "muted", text: visitorData.notice })
        : null,
      el("div", { class: "stat-row" },
        stat("Daily visitors (latest)", count(daily.length ? daily[daily.length - 1].visitors : 0)),
        stat("This month", count(monthly.length ? monthly[monthly.length - 1].visitors : 0)),
        stat("This year", count(yearly.length
          ? (yearly.find((year) => year.current) || yearly[0]).visitors
          : 0))),

      /* ---- daily window controls: paging + date filter ---- */
      el("div", { class: "visit-controls" },
        el("button", {
          class: "button button-small", type: "button", text: "‹ Previous",
          onclick: () => page(-1),
        }),
        el("span", { class: "visit-range", text: `${range.from} → ${range.to}` }),
        el("button", {
          class: "button button-small", type: "button", text: "Next ›",
          disabled: atLatest, onclick: () => page(1),
        }),
        el("span", { class: "visit-filter" },
          el("label", { class: "field-inline" },
            el("span", { class: "muted", text: "From" }),
            el("input", { class: "input", type: "date", id: "visit-from", value: range.from, max: today })),
          el("label", { class: "field-inline" },
            el("span", { class: "muted", text: "To" }),
            el("input", { class: "input", type: "date", id: "visit-to", value: range.to, max: today })),
          el("button", {
            class: "button button-small", type: "button", text: "Filter", onclick: applyFilter,
          }))),

      chartFigure({
        title: "Daily visitors",
        subtitle: `Distinct visitor-day records · Africa/Lagos · ${range.from} → ${range.to}`,
        ariaLabel: "Daily distinct visitors over time",
        chart: lineChart(daily.map((day) => ({
          label: day.date.slice(5),
          value: day.visitors,
        })), {
          format: (value) => count(value),
          emptyText: "No visitor activity recorded in this range.",
        }),
        caption: `Distinct visitor-day records per Lagos day in the selected window (page total ${count(pageTotal)} visitor-days). Monthly and yearly totals are distinct counts, never a sum of these daily values.`,
      }),
      geography.length
        ? el("div", {},
          el("h3", { class: "detail-heading", text: "Approximate geography" }),
          adminTable({
            caption: "Approximate visitor geography",
            rows: geography,
            rowKey: (row) => `${row.country || "?"}-${row.region || "?"}`,
            columns: [
              { label: "Country", render: ({ row }) => row.country || "—" },
              { label: "Region", render: ({ row }) => row.region || "—" },
              { label: "Visitor-days", className: "col-num", render: ({ row }) => count(row.visitorDays) },
            ],
          }),
          el("p", { class: "muted", text: "Approximate, from request metadata for the selected range. Raw IP addresses are never stored or shown." }))
        : null);
  }

  /* Reads the from/to date inputs and reloads the daily window. A bad or
     future-dated range is left to the backend's validation, which answers with
     the shared error envelope rendered by ui.load. */
  function applyFilter() {
    const from = document.getElementById("visit-from");
    const to = document.getElementById("visit-to");
    if (from && from.value) visitFrom = from.value;
    if (to && to.value) visitTo = to.value;
    load();
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
