// Inline SVG line charts for the Reports view. No chart library: the two charts
// here (delivery rate over time, visitors over time) are simple series, and a
// dependency the size of a charting library would blow the admin bundle budget
// for two polylines. SVG is built with createElementNS — el() uses
// document.createElement, which produces an unknown HTML element for <svg> that
// renders nothing in a real browser. Everything else still goes through el().

import { el } from "./dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** A chart-safe number: finite, or null so the series can carry a real gap. */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A responsive line chart from `points` = [{ label, value }].
 *
 * `format` renders the tooltip/title text for a value; `yMax`, when given, fixes
 * the top of the y-axis (a 0–100% rate is a 0–100 axis, not an auto one). Gaps
 * (null values) are drawn as breaks rather than a straight line through zero —
 * a missing day must never look like a zero-visitor day.
 *
 * `role="img"` + <title> keeps it readable by assistive tech, and the points are
 * also emitted as a visually-hidden table so the numbers are never trapped in an
 * image.
 */
export function lineChart(points, { format, yMax, ariaLabel, emptyText }) {
  const series = (points || []).map((point) => ({
    label: point.label,
    value: num(point.value),
  }));
  const hasData = series.some((point) => point.value !== null);
  if (!hasData) {
    const empty = document.createElement("p");
    empty.className = "chart-empty muted";
    empty.textContent = emptyText || "No data for this period yet.";
    return empty;
  }

  const width = 640;
  const height = 220;
  const pad = { top: 16, right: 16, bottom: 34, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = series.map((point) => point.value).filter((value) => value !== null);
  const top = yMax ?? Math.max(...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;
  const count = series.length;
  const xAt = (index) => pad.left + (count === 1 ? innerW / 2 : (index * innerW) / (count - 1));
  const yAt = (value) => pad.top + innerH - ((value - bottom) / span) * innerH;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", ariaLabel || "line chart");
  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = ariaLabel || "line chart";
  svg.append(title);

  // Horizontal gridlines + y-axis labels at 0, mid and top.
  const ticks = [bottom, bottom + span / 2, top];
  for (const tick of ticks) {
    const y = yAt(tick);
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(pad.left));
    line.setAttribute("x2", String(width - pad.right));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "chart-grid");
    svg.append(line);
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(pad.left - 8));
    label.setAttribute("y", String(y + 4));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = format ? format(tick) : String(Math.round(tick));
    svg.append(label);
  }

  // The line, broken into contiguous segments so gaps stay gaps.
  let segment = null;
  const flush = () => {
    if (!segment || segment.length < 2) { segment = null; return; }
    const poly = document.createElementNS(SVG_NS, "polyline");
    poly.setAttribute("points", segment.map((p) => `${xAt(p.i).toFixed(1)},${yAt(p.v).toFixed(1)}`).join(" "));
    poly.setAttribute("class", "chart-line");
    svg.append(poly);
    segment = null;
  };
  series.forEach((point, index) => {
    if (point.value === null) { flush(); return; }
    if (!segment) segment = [];
    segment.push({ i: index, v: point.value });
  });
  flush();

  // A dot per real point, with a native tooltip of the exact value.
  series.forEach((point, index) => {
    if (point.value === null) return;
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", xAt(index).toFixed(1));
    dot.setAttribute("cy", yAt(point.value).toFixed(1));
    dot.setAttribute("r", "3");
    dot.setAttribute("class", "chart-dot");
    const dotTitle = document.createElementNS(SVG_NS, "title");
    dotTitle.textContent = `${point.label}: ${format ? format(point.value) : point.value}`;
    dot.append(dotTitle);
    svg.append(dot);
  });

  // X-axis labels, thinned so they never collide on a phone.
  const step = Math.max(1, Math.ceil(count / 6));
  series.forEach((point, index) => {
    if (index % step !== 0 && index !== count - 1) return;
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", xAt(index).toFixed(1));
    label.setAttribute("y", String(height - 10));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = point.label;
    svg.append(label);
  });

  return svg;
}

/** A chart figure: title, the chart, and a caption describing the metric + axis. */
export function chartFigure({ title, subtitle, chart, caption }) {
  return el("figure", { class: "chart" },
    el("figcaption", { class: "chart-caption" },
      el("span", { class: "chart-title", text: title }),
      subtitle ? el("span", { class: "chart-subtitle muted", text: subtitle }) : null),
    chart,
    caption ? el("p", { class: "chart-note muted", text: caption }) : null);
}
