// A real .xlsx written with nothing but the language.
//
// An xlsx file is a ZIP of five small XML parts. Nothing here needs a library,
// and the admin bundle's budget has no room for one: the entries are STORED
// (method 0) rather than deflated, because a page of orders is a few kilobytes
// and compression would save bytes nobody counts at the cost of a compressor
// nobody wants shipped.
//
// Two decisions the tests pin:
//
// - The CRC-32 table is the standard IEEE one. A wrong CRC makes Excel refuse
//   the whole file while every string assertion still passes, so `crc32` is
//   exported and checked against the published vector for "123456789"
//   (0xCBF43926).
//
// - Every cell is an inline string (t="inlineStr"), never a number and never a
//   shared-string table entry. A phone number or an order reference is an
//   IDENTIFIER: written as a number, "08012345678" loses its leading zero and
//   "1.2E+10" is not something to paste into WhatsApp. One file fewer, too.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) of the bytes, as an unsigned 32-bit integer. */
export function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Stripped rather than escaped: XML 1.0 forbids these control characters
// outright, so a paste containing one would produce a file Excel calls corrupt.
// The five metacharacters below are the ones a customer name actually contains.
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function xmlText(value) {
  return String(value ?? "")
    .replace(ILLEGAL_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 0 -> A, 25 -> Z, 26 -> AA: the arithmetic form, so width never needs a table. */
function columnRef(index) {
  let ref = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    ref = String.fromCharCode(65 + ((n - 1) % 26)) + ref;
  }
  return ref;
}

function sheetXml(matrix) {
  const widths = (matrix[0] || []).map((_, column) => {
    const longest = matrix.reduce(
      (max, row) => Math.max(max, String(row[column] ?? "").length),
      8,
    );
    const width = Math.min(60, Math.max(10, longest + 2));
    return `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const rows = matrix.map((cells, r) => {
    const body = cells.map((cell, c) =>
      `<c r="${columnRef(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlText(cell)}</t></is></c>`).join("");
    return `<row r="${r + 1}">${body}</row>`;
  }).join("");
  // Frozen header: scrolling a 50-row export without the column names in sight
  // is how an operator reads a phone number against the wrong order.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    `<cols>${widths}</cols>` +
    `<sheetData>${rows}</sheetData>` +
    `</worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `</Relationships>`;

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`;
}

// MS-DOS packing of the modification time, which is what a ZIP header carries:
// time = hh:(mm):(ss/2), date = (year - 1980) << 9 | month << 5 | day.
function dosDateTime(date) {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xFFFF,
    date: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF,
  };
}

/**
 * A ZIP archive with STORED entries. Field offsets follow the APPNOTE layout
 * exactly - a central-directory offset that drifts by a byte is the classic way
 * to ship a file that only some tools can open.
 */
function zipStore(entries) {
  const { time, date } = dosDateTime(new Date());
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);   // version needed to extract
    lv.setUint16(6, 0, true);    // flags
    lv.setUint16(8, 0, true);    // method: stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);   // extra field length
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);   // version made by
    cv.setUint16(6, 20, true);   // version needed
    cv.setUint16(8, 0, true);    // flags
    cv.setUint16(10, 0, true);   // method
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); // local-header offset of THIS entry
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, part) => n + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);     // archive comment length

  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The .xlsx bytes for a matrix of cells (first row = the header row).
 *
 * Pure: no DOM, no download - which is what lets the test unzip the result,
 * verify every CRC and read the sheet XML back without clicking anything.
 */
export function buildXlsx(matrix, { sheetName = "Orders" } = {}) {
  const rows = Array.isArray(matrix) && matrix.length ? matrix : [[""]];
  const safeName = String(sheetName).replace(/[[\]:*?/\\]/g, " ").trim() || "Orders";
  const encode = (text) => new TextEncoder().encode(text);
  return zipStore([
    { name: "[Content_Types].xml", data: encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: encode(PACKAGE_RELS) },
    { name: "xl/workbook.xml", data: encode(workbookXml(safeName)) },
    { name: "xl/_rels/workbook.xml.rels", data: encode(WORKBOOK_RELS) },
    { name: "xl/worksheets/sheet1.xml", data: encode(sheetXml(rows)) },
  ]);
}

export function downloadXlsx(filename, matrix, options) {
  const blob = new Blob([buildXlsx(matrix, options)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick: the URL must still exist when click() starts the
  // download, and must not outlive it by much.
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
