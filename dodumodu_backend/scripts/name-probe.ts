import { orders, visitorDays, categories, products, orderStatusHistory } from "../src/schema";

for (const [n, t] of Object.entries({ orders, visitorDays, categories, products, orderStatusHistory })) {
  const table = t as Record<string, unknown>;
  const syms = Object.getOwnPropertySymbols(t)
    .map((s) => {
      const v = (t as Record<symbol, unknown>)[s];
      return typeof v === "string" ? `${s.toString()}=${JSON.stringify(v)}` : null;
    })
    .filter(Boolean)
    .join(", ");
  console.log(n, "| .name =", JSON.stringify(table.name), "| string symbols:", syms);
}
