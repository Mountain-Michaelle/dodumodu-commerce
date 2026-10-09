// Safe DOM construction. This module exists because of one rule, and the rule is
// worth stating before the helpers:
//
//   NOTHING that came from a person is ever assigned as HTML.
//
// Customer names, addresses, notes and internal comments are free text typed into
// a public form. Building a table row with innerHTML and a template literal means
// an order placed with the name `<img src=x onerror=...>` executes script inside
// the admin panel - which is the one place a person with access to every customer
// record is looking. textContent cannot be made to do that, so every value in
// this panel goes through textContent, and the only innerHTML in the whole admin
// is the static icon sprite the build injects.

/**
 * el("div", { class: "x" }, "text", child)
 *
 * `text` is always set with textContent. Children may be nodes or strings; a
 * string child is still treated as text, so there is no accidental HTML path.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = value; // static markup only, never data
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "value" || key === "checked" || key === "disabled" || key === "selected") {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ---- formatting, in one place so two screens cannot disagree ---- */

export function formatNaira(kobo) {
  if (kobo === null || kobo === undefined || Number.isNaN(Number(kobo))) return "-";
  return `₦${Math.round(Number(kobo) / 100).toLocaleString()}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/** A date for a <input type="date">, which always wants YYYY-MM-DD. */
export function toDateInput(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** A Date for the wire, in the shape z.string().datetime({ offset: true }) accepts. */
export function toWireTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const humanStatus = (status) => String(status || "").replace(/_/g, " ");

/**
 * A trailing-edge debounce, so typing in a search box is one request per pause
 * rather than one per keystroke. Every keystroke would be a database round trip
 * that scans a text column, so the throttle is a cost decision, not a nicety.
 */
export function debounce(fn, ms = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Copies text to the clipboard, preferring the async API and falling back to the
 * old execCommand path. The fallback matters: the async Clipboard API is only
 * available in a secure context, so on plain http://localhost over a LAN address
 * it is simply absent and "Copy CSV" would otherwise do nothing at all.
 */
export async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  document.body.removeChild(area);
  return ok;
}

