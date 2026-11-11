// Who may call which legacy admin route. ONE table, enforced for every NON-admin session; admins and the
// Cloudflare-Access operator are unrestricted exactly as before.
//
// Each section of the console (orders, products, categories, media, testimonials, reports, abuse) is a
// container: the registry key named here decides whether a user can enter it, and an admin switches that
// key on or off per user in Users & access. The default is DENY: a route with no rule here is admin-only,
// so adding a route can never silently open it to staff (route-access.test.ts fails if one is added
// without a deliberate decision).
import { effectivePerms } from "./registry";
import { PERMISSIONS, type Permission } from "./adminAuth";

export interface RouteRule { method: string; path: RegExp; need: string }

const ID = String.raw`\d+`;
const rule = (method: string, tail: string, need: string): RouteRule =>
  ({ method, path: new RegExp(`/${tail}$`), need });

export const ROUTE_RULES: readonly RouteRule[] = [
  // orders (rows are additionally scoped to the operator's own orders for mono, see orderScope)
  rule("GET", "orders", "orders.view"),
  rule("GET", `orders/${ID}`, "orders.view"),
  rule("GET", "orders/csv", "orders.export"),
  rule("GET", "orders/staff", "orders.filter_staff"),
  rule("PATCH", `orders/${ID}`, "orders.change"),
  rule("POST", `orders/${ID}/deliver`, "orders.status.delivered"),
  rule("POST", `orders/${ID}/revert`, "orders.status.delivered"),
  rule("POST", `orders/${ID}/mark-paid`, "orders.status.paid"),
  rule("POST", `orders/${ID}/mark-failed`, "orders.status.failed"),
  // products
  rule("GET", "products", "products.view"),
  rule("GET", `products/${ID}`, "products.view"),
  rule("POST", "products", "products.add"),
  rule("PATCH", `products/${ID}`, "products.change"),
  rule("PUT", `products/${ID}/images`, "products.change"),
  rule("DELETE", `products/${ID}/images/${ID}`, "products.change"),
  rule("DELETE", `products/${ID}`, "products.delete"),
  rule("GET", `products/${ID}/page`, "products.view"),
  rule("PUT", `products/${ID}/page`, "products.change"),
  // categories
  rule("GET", "categories", "categories.view"),
  rule("GET", "categories/tree", "categories.view"),
  rule("GET", `categories/${ID}`, "categories.view"),
  rule("POST", "categories", "categories.add"),
  rule("PATCH", `categories/${ID}`, "categories.change"),
  rule("DELETE", `categories/${ID}`, "categories.delete"),
  // media
  rule("GET", "media", "media.view"),
  rule("POST", "media", "media.add"),
  rule("DELETE", `media/${ID}`, "media.delete"),
  // testimonials
  rule("GET", "testimonials", "testimonials.view"),
  rule("PUT", "testimonials", "testimonials.add"),
  rule("PUT", `testimonials/${ID}`, "testimonials.change"),
  // reports (the handler narrows a mono operator to their own orders)
  rule("GET", "reports/monthly-kpis", "reports.view"),
  rule("GET", "reports/visitors", "reports.view"),
  // abuse (shadow)
  rule("GET", "spam/flagged", "abuse.view"),
  rule("GET", "spam/shadow", "abuse.view"),
  rule("GET", "spam/suspects", "abuse.view"),
  rule("POST", "spam/flag", "abuse.resolve"),
  rule("POST", `spam/${ID}/revert`, "abuse.resolve"),
  // the signed-in operator's own identity, for the console header
  rule("GET", "me", "*"),
];

/** The registry key a non-admin request needs, "*" when any signed-in operator may call it, or null = admin only. */
export function requiredKey(method: string, path: string): string | null {
  const m = method.toUpperCase();
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  for (const r of ROUTE_RULES) if (r.method === m && r.path.test(p)) return r.need;
  return null;
}

export function mayCall(role: string, grants: readonly string[], method: string, path: string): boolean {
  if (role === "admin") return true;
  const need = requiredKey(method, path);
  if (need === null) return false;
  return need === "*" || effectivePerms(role, grants).includes(need);
}

/**
 * The legacy capability set a non-admin session holds. It only has to satisfy the handlers' own second-layer
 * checks (requirePermissionOf); the rule table above is the real gate.
 */
export function legacyFromGrants(role: string, grants: readonly string[]): Permission[] {
  if (role === "admin") return Object.values(PERMISSIONS);
  const g = new Set(effectivePerms(role, grants));
  const any = (...k: string[]) => k.some((x) => g.has(x));
  const out: Permission[] = [];
  if (any("categories.view")) out.push(PERMISSIONS.categoriesRead);
  if (any("categories.add", "categories.change", "categories.delete")) out.push(PERMISSIONS.categoriesWrite);
  if (any("products.view", "testimonials.view")) out.push(PERMISSIONS.productsRead);
  if (any("products.add", "products.change", "products.delete")) out.push(PERMISSIONS.productsWrite);
  if (any("media.view")) out.push(PERMISSIONS.mediaRead);
  if (any("media.add", "media.delete")) out.push(PERMISSIONS.mediaWrite);
  if (any("orders.view", "abuse.view", "reports.view")) out.push(PERMISSIONS.ordersRead);
  if (any("orders.change", "orders.status.delivered", "abuse.resolve")) out.push(PERMISSIONS.ordersWrite);
  if (any("orders.status.paid", "orders.status.failed")) out.push(PERMISSIONS.ordersPaymentOverride);
  return out;
}
