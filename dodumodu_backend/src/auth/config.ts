// ADMIN_AUTH_V2 config — one module, spec §5.8. Verbatim values.
// Everything new is behind ADMIN_AUTH_V2 ("0" default). Flag off = new routes 404.
export const AUTH_BASE = "/auth";
// Spec §2.4: the existing admin console already owns /admin (and its /admin/*
// middleware). Mount the new admin routes under /admin-v2 so nothing existing
// is wrapped, overridden or re-ordered. /auth has no collision.
export const ADMIN_BASE = "/admin-v2";

export const OTP_LEN = 10;
export const OTP_TTL_SECS = 180;
export const OTP_RESEND_COOLDOWN_SECS = 45;
export const OTP_RESEND_MAX = 3;
export const OTP_SENDS_PER_HOUR = 10;            // per BROWSER (slot): one browser's requests never spend another's
/** Inbox-flood backstop across ALL browsers of one address. High on purpose: a stranger must not be able
 *  to exhaust it cheaply and lock the real user out of codes; trusted (recognized) browsers skip it. */
export const OTP_SENDS_PER_HOUR_GLOBAL = 100;
export const OTP_SENDS_PER_HOUR_IP = 4;
export const SEND_CAP_WINDOW = "1 hour";
export const PAIR_THRESHOLD = 5;
export const CODE_VERIFY_THRESHOLD = 10;
export const CODE_VERIFY_DECAY_SECS = 10;
export const LOCK_STEP_MIN = 10;
export const LOCK_MAX_MIN = 1440;
export const DEVICE_THRESHOLD = 5;
export const DEVICE_LOCK_STEP_MIN = 5;
export const DEVICE_LOCK_MAX_MIN = 60;
export const STRICT_THRESHOLD = 3;
export const STRICT_LOCK_STEP_MIN = 15;
export const FUSE_FRICTION_THRESHOLD = 9;
export const FUSE_DECAY_HOURS = 1;
export const FLOW_STAGE_MAX_FAILS = 3;
export const ROUND_DECAY_HOURS = 24;
export const FLOW_TTL_SECS = 900;
export const PHRASE_MIN = 12;
export const PHRASE_MAX = 64;
// Recovery thresholds (spec §4.3/§4.4). 3rd wrong TOTP unlocks the recovery
// panel; the 5th kills the flow. 3rd wrong phrase/backup blocks device+IP.
export const TOTP_FAILS_TO_UNLOCK_RECOVERY = 3;
export const TOTP_MAX_FAILS_PER_FLOW = 5;
export const DEVICE_AUTH_MAX_FAILURES = 3;
export const PHRASE_MAX_ATTEMPTS = 3;
export const SESSION_IDLE_SECS_STAFF = 3600;
export const SESSION_IDLE_SECS_ADMIN = 3600;
export const SESSION_IDLE_SECS_STRICT = 600;
export const SESSION_ABSOLUTE_SECS = 18000;
export const SESSION_ABSOLUTE_SECS_STRICT = 14400;
// Largest idle value — SESSION_LOOKUP is called with this so the query never
// prematurely filters; the Worker enforces the per-role/tier limit from the
// idle_secs it returns and never deletes an idle row (spec §5.8 / §5.11).
export const SESSION_LOOKUP_MAX_IDLE_SECS = Math.max(
  3600,
  3600,
  600,
);
// A reload (or a closed-and-reopened tab) resumes the CURRENT stage for this long after the
// last completed step. Matches the emailed-code lifetime (3 min); after it, start again.
export const FLOW_STEP_RESUME_SECS = 180;
export const STEPUP_WINDOW_SECS = 300;
export const STEPUP_WINDOW_SECS_STRICT = 120;
export const BACKUP_CODE_COUNT = 8;
export const ENROLL_WINDOW_HOURS = 72;
export const VID_TTL_SECS = 31536000;          // 365 days
export const BLOCK_IP_TTL_HOURS = 24;          // ip block after 3 wrong phrases
export const LOST_EMAIL_MAX_ATTEMPTS = 3;      // per IP, per round
export const LOST_EMAIL_ALERT_COOLDOWN_HOURS = 24;
export const ADMIN_DEVICE_MAX = 3;
export const DEVICE_TTL_SECS = 7776000;
export const DEVICE_INVITE_TTL_SECS = 900;
export const DEVICE_PENDING_SECS = 900;
export const FIRST_DEVICE_WINDOW_HOURS = 72;
export const DENIED_ALERT_COOLDOWN_HOURS = 6;
export const ADMIN_RPM_NORMAL = 60;
export const ADMIN_RPM_STRICT = 15;
export const DB_TIMEOUT_MS = 4000;
export const EMAIL_TIMEOUT_MS = 3000;
export const ADVISORY_KEY_ADMINS = 7001;
export const ADVISORY_KEY_DEVICES = 7002;

/** "1" on. Anything else (including missing) = off: new routes return 404. */
export function adminAuthEnabled(env: Record<string, string | undefined>): boolean {
  return env.ADMIN_AUTH_V2 === "1";
}

// Staff privileges registry (spec §5.8 decision 9). Deliberately distinct
// strings from the v1 adminAuth.ts capabilities ("orders:read") so the two
// systems cannot collide while both exist. Admins implicitly hold all.
// Extended by Phase 5: every key in auth/registry.ts is a valid v2 perm.
// The registry (not this map) is the source of truth for roles/adminOnly.
export const PERMISSIONS = {
  ordersView: "orders.view",
  ordersAdd: "orders.add",
  ordersChange: "orders.change",
  ordersStatusDelivered: "orders.status.delivered",
  ordersStatusPaid: "orders.status.paid",
  ordersStatusFailed: "orders.status.failed",
  ordersStatusCancelled: "orders.status.cancelled",
  ordersStatusNotPicking: "orders.status.not_picking",
  ordersDelete: "orders.delete",
  ordersExport: "orders.export",
  ordersFilterStaff: "orders.filter_staff",
  ordersAuditView: "orders.audit.view",
  ordersAssign: "orders.assign",
  ordersSpam: "orders.spam",
  dashboardView: "dashboard.view",
  productsView: "products.view",
  productsAdd: "products.add",
  productsChange: "products.change",
  productsPriceChange: "products.price.change",
  productsStockChange: "products.stock.change",
  productsDelete: "products.delete",
  categoriesView: "categories.view",
  categoriesAdd: "categories.add",
  categoriesChange: "categories.change",
  categoriesDelete: "categories.delete",
  testimonialsView: "testimonials.view",
  testimonialsAdd: "testimonials.add",
  testimonialsChange: "testimonials.change",
  testimonialsApprove: "testimonials.approve",
  testimonialsDelete: "testimonials.delete",
  abuseView: "abuse.view",
  abuseResolve: "abuse.resolve",
  abuseDismiss: "abuse.dismiss",
  abuseDelete: "abuse.delete",
  reportsView: "reports.view",
  reportsExport: "reports.export",
  usersView: "users.view",
  usersManage: "users.manage",
  accessManage: "access.manage",
  authlogView: "authlog.view",
  blocksManage: "blocks.manage",
  accountRequestsManage: "account_requests.manage",
} as const;

export type V2Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_V2_PERMS: readonly string[] = Object.values(PERMISSIONS);
export function isV2Perm(p: string): p is V2Permission {
  return (ALL_V2_PERMS as readonly string[]).includes(p);
}

/** Active devices kept per admin. A cookie-less browser registers a new device; beyond this the
 *  least-recently-seen ones are retired (their sessions end with them), so clearing cookies
 *  repeatedly can never grow the table without bound. */
export const MAX_ACTIVE_DEVICES = 10;

// Device invites: abuse limits (per hour) and admin list paging.
export const INVITE_CREATE_PER_HOUR = 20;       // per administrator
export const INVITE_ACCEPT_PER_HOUR_IP = 20;    // per network, valid or not
export const ADMIN_LIST_DEFAULT_LIMIT = 25;
export const ADMIN_LIST_MAX_LIMIT = 100;
