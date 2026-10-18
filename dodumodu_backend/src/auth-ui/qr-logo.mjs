// ===== FILE: <your-static-dir>/qr-logo.mjs =====
import qrcode from "./qr.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const INK = "#0f172a";
const PAPER = "#ffffff";
const LABEL = "TOTP enrolment QR code";
const LEVELS = new Set(["L", "M", "Q", "H"]);
const HEX = /^#[0-9a-f]{3,8}$/i;

/** Build the QR matrix and a compact path (one run per row, unit coordinates). */
function layout(data, opts = {}) {
  const size = Number(opts.size) > 0 ? Number(opts.size) : 220;
  const quiet = Number.isInteger(opts.quiet) && opts.quiet >= 0 ? opts.quiet : 4;
  const ecc = LEVELS.has(opts.ecc) ? opts.ecc : "M";

  const qr = qrcode(0, ecc); // 0 = auto-pick the smallest version that fits
  qr.addData(String(data), "Byte");
  qr.make();

  const n = qr.getModuleCount();
  const total = n + quiet * 2;

  let d = "";
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) { c++; continue; }
      const start = c;
      while (c < n && qr.isDark(r, c)) c++;
      d += `M${start + quiet} ${r + quiet}h${c - start}v1h-${c - start}z`;
    }
  }

  // Optional accent: recolours only the inner 3x3 of each finder "eye".
  // Use a DARK colour; light colours reduce scan reliability.
  let eyes = "";
  const accent = typeof opts.accent === "string" && HEX.test(opts.accent) ? opts.accent : null;
  if (accent) {
    for (const [r, c] of [[2, 2], [2, n - 5], [n - 5, 2]]) {
      eyes += `M${c + quiet} ${r + quiet}h3v3h-3z`;
    }
  }
  return { size, total, d, eyes, accent };
}

/** SVG as a string (tests, downloads, server-side use). */
export function makeQrSvg(data, opts = {}) {
  const { size, total, d, eyes, accent } = layout(data, opts);
  return (
    `<svg xmlns="${SVG_NS}" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${LABEL}">` +
    `<rect width="${total}" height="${total}" fill="${PAPER}"/>` +
    `<path d="${d}" fill="${INK}"/>` +
    (eyes ? `<path d="${eyes}" fill="${accent}"/>` : "") +
    `</svg>`
  );
}

/** SVG as a live DOM element. Not affected by CSP img-src: use this in the page. */
export function makeQrElement(data, opts = {}) {
  const { size, total, d, eyes, accent } = layout(data, opts);
  const el = (name, attrs) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  };
  const svg = el("svg", {
    width: size, height: size, viewBox: `0 0 ${total} ${total}`,
    "shape-rendering": "crispEdges", role: "img", "aria-label": LABEL,
  });
  svg.appendChild(el("rect", { width: total, height: total, fill: PAPER }));
  svg.appendChild(el("path", { d, fill: INK }));
  if (eyes) svg.appendChild(el("path", { d: eyes, fill: accent }));
  return svg;
}