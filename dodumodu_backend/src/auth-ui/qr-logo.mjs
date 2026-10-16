import qrcode from './qr.js';

// Dodumodu brand orange — used for QR corner markers (~#f59e0b)
const BRAND_ORANGE = '#f59e0b';

// ECC levels: 'L', 'M', 'Q', 'H' (strings, per qrcode-generator API)
// 'H' = highest error correction (~30% damage tolerance)
const ECC_MAP = { L: 'L', M: 'M', Q: 'Q', H: 'H' };

/**
 * Generate an SVG QR code with brand-orange corner markers.
 * No centered logo — nothing covers the QR data modules.
 * Returns an SVG string safe to use as `src="data:image/svg+xml;base64,..."`
 */
export function makeQrSvg(data, opts = {}) {
  const size = opts.size || 260;
  const margin = opts.margin || 24;
  const ecc = ECC_MAP[opts.ecc || 'H'] ?? 'H';

  const qr = qrcode(0, ecc);
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const cell = (size - margin * 2) / count;
  const qrWidth = count * cell;
  const qrX = margin;
  const qrY = margin;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
      `viewBox="0 0 ${size} ${size}" role="img" aria-label="TOTP enrolment QR code">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);

  // Draw QR modules
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        const x = margin + c * cell;
        const y = margin + r * cell;
        parts.push(
          `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" ` +
            `height="${cell.toFixed(2)}" fill="#0f172a"/>`,
        );
      }
    }
  }

  // Brand-orange corner markers — four corners of the QR grid area.
  // Each marker is a small orange square inset slightly from the outer edge,
  // so they frame the QR without touching its data modules.
  const markerSize = cell * 1.6;
  const markerInset = cell * 0.6;
  const cornerPositions = [
    { x: qrX + markerInset, y: qrY + markerInset },                                   // top-left
    { x: qrX + qrWidth - markerInset - markerSize, y: qrY + markerInset },             // top-right
    { x: qrX + markerInset, y: qrY + qrWidth - markerInset - markerSize },             // bottom-left
    { x: qrX + qrWidth - markerInset - markerSize, y: qrY + qrWidth - markerInset - markerSize }, // bottom-right
  ];
  for (const pos of cornerPositions) {
    parts.push(
      `<rect x="${pos.x.toFixed(2)}" y="${pos.y.toFixed(2)}" ` +
        `width="${markerSize.toFixed(2)}" height="${markerSize.toFixed(2)}" ` +
        `fill="${BRAND_ORANGE}"/>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}