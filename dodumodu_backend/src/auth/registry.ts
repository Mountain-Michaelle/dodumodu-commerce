// Permission registry — spec §5/§5A. SINGLE source of truth for v2 authorization.
// Two entry kinds: section (<area>.view) and privilege (<area>.<action>).
// Per-status keys are generated from the CRM transition table (no bare
// `orders.status` wildcard — an alias can never silently broaden access).
// `adminOnly` is a code-level flag: the server enforces it from THIS table,
// never from a DB row or UI state, so a tampered grant can't escalate.
import type { OrderAction } from "../services/orderCrmService";

export type RegistryEntryType = "section" | "privilege";
export type NotifyKind = "instant" | "digest" | "none";
export type V2Role = "admin" | "mono" | "general";

export interface RegistryEntry {
  key: string;
  type: RegistryEntryType;
  group: string;
  label: string;
  adminOnly: boolean;
  roles: readonly V2Role[];
  scoped: boolean;
  requires: readonly string[];
  important: boolean;
  notify: NotifyKind;
  sensitive?: boolean;
}

function sec(
  key: string, group: string, label: string,
  opts: Partial<Pick<RegistryEntry, "adminOnly" | "roles" | "scoped" | "important" | "notify" | "sensitive">> = {},
): RegistryEntry {
  return {
    key, type: "section", group, label,
    adminOnly: opts.adminOnly ?? false,
    roles: opts.roles ?? (["admin", "mono", "general"] as const),
    scoped: opts.scoped ?? false,
    requires: [],
    important: opts.important ?? false,
    notify: opts.notify ?? "none",
    sensitive: opts.sensitive,
  };
}

function priv(
  key: string, group: string, label: string, requires: readonly string[],
  opts: Partial<Pick<RegistryEntry, "adminOnly" | "roles" | "scoped" | "important" | "notify" | "sensitive">> = {},
): RegistryEntry {
  return {
    key, type: "privilege", group, label, requires,
    adminOnly: opts.adminOnly ?? false,
    roles: opts.roles ?? (["admin", "mono", "general"] as const),
    scoped: opts.scoped ?? false,
    important: opts.important ?? false,
    notify: opts.notify ?? "none",
    sensitive: opts.sensitive,
  };
}

// CRM action -> order status it produces. The ONLY mapping between a UI verb
// and the permission that authorizes it, derived from the same transition
// rules orderCrmService.availableActions enforces. Reverts restore the
// pre-action status, so they need the same privilege as the action.
const ACTION_STATUS: Record<OrderAction, string> = {
  deliver: "delivered",
  revert: "delivered",
  "mark-paid": "paid",
  "mark-failed": "failed",
  cancel: "cancelled",
  "revert-cancel": "cancelled",
  "mark-not-picking": "not_picking",
  "revert-not-picking": "not_picking",
};

const STAFF_ROLES = ["mono", "general"] as const;

/** One `orders.status.<target>` privilege per grantable CRM target status. */
function statusPrivs(): RegistryEntry[] {
  const seen = new Set<string>();
  const out: RegistryEntry[] = [];
  for (const action of Object.keys(ACTION_STATUS) as OrderAction[]) {
    const target = ACTION_STATUS[action];
    if (target === "cancelled" || target === "not_picking") continue; // reserved: no non-admin transition
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(priv(`orders.status.${target}`, "orders", `Set status ${target}`, ["orders.view"], {
      scoped: true, important: true, notify: "digest",
    }));
  }
  return out;
}

export const REGISTRY: readonly RegistryEntry[] = [
  sec("dashboard.view", "dashboard", "View dashboard"),
  sec("orders.view", "orders", "View orders", { scoped: true }),
  priv("orders.add", "orders", "Create order", ["orders.view"], { scoped: true }),
  priv("orders.change", "orders", "Edit order content", ["orders.view"], { scoped: true }),
  ...statusPrivs(),
  priv("orders.export", "orders", "Export orders", ["orders.view"], {
    scoped: true, important: true, notify: "digest", roles: ["admin", "general"],
  }),
  priv("orders.filter_staff", "orders", "Filter by staff", ["orders.view"], { roles: ["admin", "general"] }),
  priv("orders.audit.view", "orders", "View order audit", ["orders.view"], { roles: ["admin", "general"] }),
  priv("orders.assign", "orders", "Assign orders", ["orders.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  priv("orders.delete", "orders", "Delete orders", ["orders.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  priv("orders.spam", "orders", "Mark spam", ["orders.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  sec("products.view", "products", "View products", { roles: ["admin", "general"] }),
  priv("products.add", "products", "Add product", ["products.view"], { roles: ["admin", "general"] }),
  priv("products.change", "products", "Edit product", ["products.view"], { roles: ["admin", "general"] }),
  priv("products.price.change", "products", "Change price", ["products.view"], {
    roles: ["admin", "general"], important: true, notify: "digest",
  }),
  priv("products.stock.change", "products", "Change stock", ["products.view"], { roles: ["admin", "general"] }),
  priv("products.delete", "products", "Delete product", ["products.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  sec("media.view", "media", "View media", { roles: ["admin", "general"] }),
  priv("media.add", "media", "Upload media", ["media.view"], { roles: ["admin", "general"] }),
  priv("media.delete", "media", "Delete media", ["media.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  sec("categories.view", "categories", "View categories", { roles: ["admin", "general"] }),
  priv("categories.add", "categories", "Add category", ["categories.view"], { roles: ["admin", "general"] }),
  priv("categories.change", "categories", "Edit category", ["categories.view"], { roles: ["admin", "general"] }),
  priv("categories.delete", "categories", "Delete category", ["categories.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  sec("testimonials.view", "testimonials", "View testimonials", { roles: ["admin", "general"] }),
  priv("testimonials.add", "testimonials", "Add testimonial", ["testimonials.view"], { roles: ["admin", "general"] }),
  priv("testimonials.change", "testimonials", "Edit testimonial", ["testimonials.view"], { roles: ["admin", "general"] }),
  priv("testimonials.approve", "testimonials", "Approve testimonial", ["testimonials.view"], { roles: ["admin", "general"] }),
  priv("testimonials.delete", "testimonials", "Delete testimonial", ["testimonials.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  sec("abuse.view", "abuse", "View abuse reports", { roles: ["admin", "general"] }),
  priv("abuse.resolve", "abuse", "Resolve abuse report", ["abuse.view"], { roles: ["admin", "general"] }),
  priv("abuse.dismiss", "abuse", "Dismiss abuse report", ["abuse.view"], { roles: ["admin", "general"] }),
  priv("abuse.delete", "abuse", "Delete abuse record", ["abuse.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  sec("settings.manage", "settings", "Discount tiers and payment rules", { adminOnly: true, roles: ["admin"] }),
  sec("reports.view", "reports", "View reports", { scoped: true }),
  priv("reports.export", "reports", "Export reports", ["reports.view"], {
    scoped: true, important: true, notify: "digest",
  }),
  sec("users.view", "users", "View users", { adminOnly: true, roles: ["admin"] }),
  priv("users.manage", "users", "Manage users", ["users.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  priv("access.manage", "access", "Manage access", ["users.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  priv("authlog.view", "security", "View auth log", ["users.view"], { adminOnly: true, roles: ["admin"] }),
  priv("blocks.manage", "security", "Manage blocks", ["users.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant", sensitive: true,
  }),
  priv("account_requests.manage", "security", "Manage account requests", ["users.view"], {
    adminOnly: true, roles: ["admin"], important: true, notify: "instant",
  }),
];

const BY_KEY = new Map(REGISTRY.map((e) => [e.key, e]));

/** Look up one registry entry. Unknown keys return undefined (never effective). */
export function registryGet(key: string): RegistryEntry | undefined {
  return BY_KEY.get(key);
}

/** All keys, for the coverage check and the access-control UI. */
export function registryKeys(): string[] {
  return REGISTRY.map((e) => e.key);
}

/**
 * Effective permissions for a user: admins hold everything implicitly;
 * everyone else gets grants ∩ registry(role) − adminOnly. Unknown,
 * malformed, or role-disallowed grants are never effective. `requires`
 * dependencies are enforced: a privilege whose section is missing is dropped.
 */
export function effectivePerms(role: string, grants: readonly string[]): string[] {
  if (role === "admin") return REGISTRY.map((e) => e.key);
  const out = new Set<string>();
  for (const g of grants) {
    const e = BY_KEY.get(g);
    if (!e) continue;
    if (e.adminOnly) continue;
    if (!(e.roles as readonly string[]).includes(role as V2Role)) continue;
    out.add(g);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...out]) {
      const e = BY_KEY.get(key)!;
      for (const req of e.requires) {
        if (!out.has(req)) { out.delete(key); changed = true; break; }
      }
    }
  }
  return [...out];
}

/**
 * Revoking a section cascades to dependent privileges. Returns the removed
 * keys (for the diff + audit rows). Pure — the caller persists.
 */
export function cascadeOnRevoke(held: readonly string[], revoked: string): string[] {
  const removed = new Set<string>([revoked]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of held) {
      if (removed.has(key)) continue;
      const e = BY_KEY.get(key);
      if (!e) continue;
      for (const req of e.requires) {
        if (removed.has(req)) { removed.add(key); changed = true; break; }
      }
    }
  }
  return [...removed];
}

/** Role presets — copied to grants at creation, then freely editable. */
export function presetForRole(role: V2Role): string[] {
  const statusKeys = REGISTRY.filter((e) => e.key.startsWith("orders.status.")).map((e) => e.key);
  if (role === "admin") return REGISTRY.map((e) => e.key);
  if (role === "general") {
    return ["orders.view", "orders.change", ...statusKeys,
      "orders.export", "orders.filter_staff", "reports.view", "reports.export",
      "products.view", "categories.view", "testimonials.view", "abuse.view", "dashboard.view"];
  }
  return ["orders.view", "orders.change", ...statusKeys, "reports.view", "dashboard.view"];
}

/** CRM verb -> required permission key. Reverts need the same key. */
export function permForAction(action: OrderAction): string {
  return `orders.status.${ACTION_STATUS[action]}`;
}

/** Staff roles constant for scope checks. */
export const STAFF_ROLES_LIST: readonly string[] = STAFF_ROLES;

