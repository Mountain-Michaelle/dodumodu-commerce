// The one place that decides who is asking, and what they may do.
//
// The V1 model is deliberately small: Cloudflare Access authenticates the
// operator and forwards the verified email in a header, and this module is the
// only code that reads it. Every admin route therefore asks the same question
// through the same door instead of each repeating a header check, so the answer
// to "who may mark an order paid" has exactly one location in the codebase.
//
// It is a seam, not a system. There is no users table, no roles table and no
// permissions table yet, and none is needed to run the business. What is here is
// the boundary those would later slot into: a Principal is resolved once per
// request, and a permission is a plain string checked in one place. Adding
// users/roles/permissions later means teaching resolvePrincipal to look a role
// up and mapping role names onto these same permission strings - the route
// handlers do not change at all. That is the entire reason this file exists
// rather than `if (email) { ... }` scattered through the routes.

// Every distinct authority in the admin, named as a capability rather than as a
// route. A permission that is just a URL would have to change whenever a path
// changes; a capability does not.
export const PERMISSIONS = {
  categoriesRead: "categories:read",
  categoriesWrite: "categories:write",
  productsRead: "products:read",
  productsWrite: "products:write",
  mediaRead: "media:read",
  mediaWrite: "media:write",
  ordersRead: "orders:read",
  ordersWrite: "orders:write",
  /** Marking an order paid/failed by hand, as opposed to moving a delivery. */
  ordersPaymentOverride: "orders:payment-override",
  ordersDelete: "orders:delete",
  settingsWrite: "settings:write",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// What the trusted operator can do today. One list, so narrowing the admin to
// fewer capabilities later is a change here and not a search through the routes.
const OPERATOR_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/**
 * An authenticated operator. `email` is what Access asserted; `permissions` is
 * what this process decided that operator may do. Keeping the two fields apart
 * is the point: the first is a claim from outside, the second is a decision made
 * here, and only the second is allowed to authorize anything.
 */
export type Principal = {
  email: string;
  permissions: readonly Permission[];
  /**
   * Set for a signed-in admin-console session. Absent for the Cloudflare-Access operator, who is the owner
   * and unrestricted. Row-level scoping (orderScope) reads it: a "mono" operator only sees their own orders.
   */
  role?: string;
};

/**
 * Nobody proved who they are. 401: the request may be retried after
 * authenticating, and the panel should send the operator to Access to do so.
 */
export class UnauthorizedError extends Error {
  constructor(readonly reason: string) {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/**
 * We know who they are and they may not do this. 403: retrying will not help,
 * because the answer is about the person rather than the request.
 */
export class ForbiddenError extends Error {
  constructor(readonly permission: Permission) {
    super("You do not have permission to do that");
    this.name = "ForbiddenError";
  }
}

/** The header Cloudflare Access sets once it has authenticated the operator. */
export const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";

/**
 * Optional operator allowlist (ADMIN_OPERATORS, comma separated). When it is
 * empty - the default - any identity Access vouched for is an operator, which is
 * correct as long as Access itself admits only the business owner. Setting it
 * narrows that to named people, so adding a second person to the Access policy
 * does not silently promote them to full admin.
 *
 * It is read from configuration here and nowhere else, which is the reason a
 * personal email address never appears in a route file.
 */
export function operatorAllowList(adminOperators: string | undefined): string[] {
  return (adminOperators ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

/**
 * Resolves the caller, or throws. Never returns a half-built principal: a
 * request either has an identity this process accepts, or it does not get past
 * this call. That is what keeps "the button is hidden, so it is fine" from ever
 * being an answer.
 */
export function resolvePrincipal(email: string | undefined, adminOperators?: string): Principal {
  if (!email) throw new UnauthorizedError("no_access_identity");

  const normalized = email.trim().toLowerCase();
  if (normalized === "") throw new UnauthorizedError("blank_access_identity");

  const allowList = operatorAllowList(adminOperators);
  if (allowList.length > 0 && !allowList.includes(normalized)) {
    // Authenticated, just not on the list. Reported as a refusal rather than as
    // a missing identity, because Access did its job and the reason differs.
    throw new ForbiddenError(PERMISSIONS.ordersRead);
  }

  return { email: normalized, permissions: OPERATOR_PERMISSIONS };
}

/** True when this principal may perform this action. */
export function can(principal: Principal, permission: Permission): boolean {
  return principal.permissions.includes(permission);
}

/** Throws unless the principal may perform this action. The one call a route makes. */
export function requirePermission(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) throw new ForbiddenError(permission);
}
