// Phase 6 — row-level authorization for the order surface (spec §5.4).
//
// The registry guard answers "may this role touch orders at all"; orderScope
// answers the narrower, per-row question "which orders may THIS operator see or
// change". It is the single place that rule lives, derived ONLY from the
// session's role + email so a caller can never widen it by passing something
// else. The v1 /admin console is NOT scoped (it is Cloudflare-Access gated and
// must stay untouched), so this is applied only on the /admin-v2 routes.
//
// Rule (currentwork.md / route-registry.md):
//   admin   -> unrestricted (implicitly holds everything).
//   general -> unrestricted here: a general operator sees all staff orders and
//              may narrow them with the orders.filter_staff affordance. Scoping
//              is a VISIBILITY floor, not a per-assignee filter.
//   mono    -> assigned_to = self, and nothing else. An unassigned order is not
//              theirs, so it is invisible (404), not merely un-actionable.
//
// Fail-closed: anything that is not admin or general is treated as the narrowest
// role, so a future/legacy role never silently gains full visibility.

import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { orders } from "../schema";

/** The minimum the rule needs off a session: who is asking. */
export interface ScopeUser {
  role: string;
  email: string;
}

export interface OrderScopeOptions {
  /**
   * Restrict to orders that have been routed to a staff member
   * (assigned_to IS NOT NULL) — the "assigned work" view. Off by default; a
   * caller opts in rather than getting a surprise floor.
   */
  staff?: boolean;
}

export interface OrderScope {
  /** True when the rule narrows visibility to this operator's own orders. */
  readonly restricted: boolean;
  /**
   * The WHERE predicate for list/count/export/bulk queries, or undefined when
   * the role is unrestricted and no staff filter was requested. Fold it into
   * the existing WHERE with `and(...)`; undefined composes cleanly.
   */
  sqlWhere(): SQL | undefined;
  /**
   * Whether one already-read row is in scope. The SAME rule as sqlWhere, so a
   * detail read conceals (404) or a write refuses exactly what a list would
   * have hidden — two forms, one rule.
   */
  allows(assignedTo: string | null): boolean;
}

export function orderScope(user: ScopeUser, opts: OrderScopeOptions = {}): OrderScope {
  // Only admin/general see beyond their own orders. mono — and any role we do
  // not recognise — is pinned to self.
  const restricted = user.role !== "admin" && user.role !== "general";

  const parts: SQL[] = [];
  if (restricted) parts.push(eq(orders.assignedTo, user.email));
  if (opts.staff) parts.push(sql`${orders.assignedTo} IS NOT NULL`);

  return {
    restricted,
    sqlWhere() {
      if (parts.length === 0) return undefined;
      return parts.length === 1 ? parts[0] : and(...parts);
    },
    allows(assignedTo) {
      if (opts.staff && assignedTo == null) return false;
      if (restricted) return assignedTo === user.email;
      return true;
    },
  };
}
