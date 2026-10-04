import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsvField, toCsvRow, orderCsv } from "./csv";
import type { OrderListItem } from "../../data/ordersRepo";

/* CSV escaping lives here and only here. Two copies - one server-side and one in
   the panel - drift the moment one of them grows a column or fixes a quoting bug,
   and the symptom is a spreadsheet that silently splits an address across two
   cells. These pin the rules that make that impossible. */

test("an ordinary value is not quoted", () => {
  assert.equal(toCsvField("Lagos"), "Lagos");
  assert.equal(toCsvField(1500000), "1500000");
  assert.equal(toCsvField(null), "");
  assert.equal(toCsvField(undefined), "");
});

test("a comma forces quoting, so a field cannot become two columns", () => {
  // "12 Allen Avenue, Ikeja" unquoted is read by a spreadsheet as the address AND a
  // second, empty column - which is how an export quietly corrupts.
  assert.equal(toCsvField("12 Allen Avenue, Ikeja"), '"12 Allen Avenue, Ikeja"');
});

test("a quote inside a value is doubled", () => {
  // The part that is easy to miss: an un-doubled quote closes the field early and
  // the rest of the name becomes a new column.
  assert.equal(toCsvField('Chioma O"Brien'), '"Chioma O""Brien"');
  assert.equal(toCsvField('He said "no", loudly'), '"He said ""no"", loudly"');
});

test("a newline inside a value is quoted, so the row cannot split in two", () => {
  assert.equal(toCsvField("line one\nline two"), '"line one\nline two"');
  assert.equal(toCsvField("carriage\rreturn"), '"carriage\rreturn"');
});

test("a row is its fields joined, quoting only what needs it", () => {
  assert.equal(toCsvRow(["plain", "has,comma", 'has"quote']), 'plain,"has,comma","has""quote"');
});

test("a date is exported as an ISO string, not a locale format", () => {
  const field = toCsvField(new Date("2026-01-03T10:30:00.000Z"));
  assert.equal(field, "2026-01-03T10:30:00.000Z");
});

test("the order export has a header row and one line per order", () => {
  const order = {
    id: 1,
    reference: "ord-abc-12345678",
    customerName: "Chioma, O'Brien",
    amount: 1500000,
    productName: "Glow Serum",
    productSlug: "glow-serum",
    categoryName: "Skin Cares",
    createdAt: new Date("2026-01-03T10:30:00.000Z"),
  } as unknown as OrderListItem;

  const csv = orderCsv([order]);
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 2);
  // The header names the columns, so a spreadsheet does not have to guess.
  assert.match(lines[0], /^id,reference,/);
  assert.match(lines[0], /amount/);
  // Money is in kobo, exactly as stored: a CSV that divided by 100 would be a
  // second, competing definition of the price.
  assert.match(lines[1], /1500000/);
  // The tricky customer name survives intact, comma and all. Note the apostrophe
  // is NOT doubled: the field is already quoted because of the comma, and a lone
  // apostrophe inside a quoted field is just a character. Doubling is only
  // required for a literal double quote, which the test above covers.
  assert.match(lines[1], /"Chioma, O'Brien"/);
});

test("a null category name exports as an empty cell, not as the text null", () => {
  const order = { id: 1, categoryName: null } as unknown as OrderListItem;
  const csv = orderCsv([order]);
  assert.equal(csv.includes("null"), false);
});
