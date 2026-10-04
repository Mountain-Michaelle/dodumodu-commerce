import type { OrderListItem } from "../../data/ordersRepo";

// CSV for the orders table, built in ONE place on purpose.
//
// Two copies of this - one server-side and one in the panel - drift the moment
// one of them grows a column or fixes a quoting bug, and the symptom is a
// spreadsheet that silently splits an address across two cells. So the escaping
// rule below is the only rule.
//
// The rule itself is RFC 4180: a value is wrapped in double quotes if it contains
// a comma, a quote, a newline or a carriage return, and any quote inside it is
// doubled. That doubling is the part that is easy to miss and the reason a name
// like O"Brien corrupts an export otherwise - the quote closes the field early
// and the rest of the name becomes a new column.

const NEEDS_QUOTING = /[",\r\n]/;

export function toCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (!NEEDS_QUOTING.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsvRow(values: unknown[]): string {
  return values.map(toCsvField).join(",");
}

// The columns, in the order they appear. Money is exported in kobo, exactly as
// stored: a CSV that silently divided by 100 would be a second, competing
// definition of the price, and the reconciliation someone does from a
// spreadsheet would not agree with the one the database does.
const COLUMNS: (keyof OrderListItem | "deliveredAt")[] = [
  "id", "reference", "createdAt", "status", "paymentMethod", "deliveredAt",
  "customerName", "phone", "whatsapp", "address", "state",
  "productName", "productSlug", "categoryName",
  "quantity", "unitPrice", "discountPercent", "discountAmount", "amount", "currency",
];

function cellFor(order: OrderListItem, column: string): unknown {
  if (column === "productName") return order.productName;
  if (column === "productSlug") return order.productSlug;
  if (column === "categoryName") return order.categoryName ?? "";
  return order[column as keyof OrderListItem];
}

export function orderCsv(orders: OrderListItem[]): string {
  const header = toCsvRow(COLUMNS);
  const body = orders.map((order) => toCsvRow(COLUMNS.map((column) => cellFor(order, String(column)))));
  return [header, ...body].join("\r\n");
}
