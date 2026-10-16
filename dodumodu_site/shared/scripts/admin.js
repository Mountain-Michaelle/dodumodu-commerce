import { el, mount, $ } from "./admin/dom.js";
import { loadIdentity, loadV2Identity, ApiError, v2api } from "./admin/api.js";
import { buildShell } from "./admin/layout.js";
import { toast, errorState, openModal, confirmDialog } from "./admin/ui.js";
import { ordersView } from "./admin/views/orders.js";
import { categoriesView } from "./admin/views/categories.js";
import { productsView } from "./admin/views/products.js";
import { mediaView } from "./admin/views/media.js";
import { testimonialsView } from "./admin/views/testimonials.js";
import { discountsView, paymentView } from "./admin/views/settings.js";
import { shadowView } from "./admin/views/shadow.js";
import { blocksView } from "./admin/views/blocks.js";
import { reportsView } from "./admin/views/reports.js";
import { usersView } from "./admin/views/users.js";
import { authlogView } from "./admin/views/authlog.js";
import { notificationsView } from "./admin/views/notifications.js";

// The admin entry point, and the only module the build names.
//
// It does three things and nothing else: ask who the operator is, build the shell,
// and route. Every screen is a view module reached through ROUTES below, so adding
// a resource is one import and one line here - not a new <li>, a new panel and a
// new set of globals.
//
// The old panel was a 262-line file that drew five tabs itself and called fetch()
// inline. Everything below is deliberately the opposite: the shell knows the
// navigation, the views know their data, and neither knows how the other's DOM
// works.

const ROUTES = {
  orders: ordersView,
  reports: reportsView,
  categories: categoriesView,
  products: productsView,
  media: mediaView,
  testimonials: testimonialsView,
  discounts: discountsView,
  payment: paymentView,
  shadow: shadowView,
  blocks: blocksView,
  users: usersView,
  authlog: authlogView,
  notifications: notificationsView,
};

// "Product pages" is not its own screen: it is the product editor with the page
// content open, so the route resolves to the products view and passes the product
// id along. Aliasing it here rather than duplicating the screen is what keeps two
// lists of products from existing.
const ALIASES = { pages: "products" };

// Module scope, not boot()'s locals. render() is a module-level function, so the
// shell and the identity it needs have to live here: declared inside boot() they
// were unreachable from render(), and since boot() is async the resulting
// ReferenceError was swallowed as an unhandled rejection - leaving the sidebar
// drawn (buildShell mounts it) and the main panel completely empty, with nothing
// in the console to explain it.
let shell = null;
let identity = null;
let v2identity = null;

function routeFromHash() {
  const raw = (window.location.hash || "#orders").replace(/^#/, "");
  const [name, arg] = raw.split("/");
  const id = ALIASES[name] || name;
  return { id: ROUTES[id] ? id : "orders", arg };
}

function navigate(name, arg) {
  const target = arg ? `#${name}/${arg}` : `#${name}`;
  if (window.location.hash === target) render();
  else window.location.hash = target;
}

function render() {
  if (!shell) return;
  let { id, arg } = routeFromHash();
  // Unregistered route (e.g. mono bookmarking an admin page): fall back to
  // the first route the operator may actually open, not the default.
  if (shell.isHidden && shell.isHidden(id)) {
    const first = shell.firstVisible && shell.firstVisible();
    if (first) {
      window.location.hash = `#${first}`;
      return;
    }
    id = "orders";
  }
  const view = ROUTES[id]({ shell, identity, onNavigate: navigate });

  // A breadcrumb back to the list whenever a deep link is open, so a bookmarked
  // product editor never traps somebody on a page with no way out.
  const trail = arg
    ? [{ label: shell.titleFor(id) || id, id }, { label: `#${arg}` }]
    : null;

  shell.setRoute(id, trail);
  view.start(arg);
}

/**
 * The one gate in front of the whole console.
 *
 * A 401 here means Cloudflare Access did not vouch for the operator, and there is
 * nothing this page can do about it - the right move is to say so plainly rather
 * than to render an empty console full of failing requests. Everything else still
 * renders, so a misconfigured permission list does not present as "broken".
 */
async function boot() {
  const root = $("#app");
  try {
    identity = await loadIdentity();
  } catch (err) {
    const unauthorized = err instanceof ApiError && (err.isUnauthorized || err.isForbidden);
    mount(root, el("div", { class: "boot boot-blocked" },
      el("h1", { class: "boot-title", text: unauthorized ? "Sign in required" : "Admin unavailable" }),
      el("p", { class: "muted", text: unauthorized
        ? "This console is behind Cloudflare Access. Sign in through the admin address, then reload."
        : (err?.message || "The admin API could not be reached.") }),
      el("button", { class: "button", type: "button", text: "Reload", onclick: () => window.location.reload() })));
    return;
  }

  // v2 session identity (role, perms, stepup, perms version). Absent when the
  // flag is off or no v2 session exists — the v1 shape keeps working alone.
  v2identity = await loadV2Identity();
  if (v2identity) {
    identity = {
      ...identity,
      role: v2identity.role,
      v2perms: v2identity.perms || [],
      permsVersion: v2identity.perms_version,
      stepupOk: v2identity.stepup_ok,
      tier: v2identity.tier,
    };
  }

  shell = buildShell({ root, identity, onNavigate: navigate });
  window.addEventListener("hashchange", render);

  // Instant access effect: the server bumps perms_version on every grant
  // change, so a stale open tab refetches identity when the version moves.
  watchPermsVersion();
  refreshBell();

  // Anything a view throws would otherwise leave the panel blank with nothing in
  // the console to explain it - which is exactly the failure this is here to
  // prevent, so it is caught and shown rather than allowed to vanish.
  window.addEventListener("error", (event) => showFatal(event.error || event.message));
  window.addEventListener("unhandledrejection", (event) => showFatal(event.reason));

  render();
}

/** Re-fetch identity when the server's perms_version moves. */
function watchPermsVersion() {
  let known = identity?.permsVersion ?? null;
  if (known === null) return;
  const check = async () => {
    const next = await loadV2Identity().catch(() => null);
    if (next && next.perms_version !== known) {
      known = next.perms_version;
      identity = { ...identity, role: next.role, v2perms: next.perms || [], permsVersion: next.perms_version, stepupOk: next.stepup_ok, tier: next.tier };
      toast("Your access was updated. Reloading…", "info");
      setTimeout(() => window.location.reload(), 1200);
    }
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
}

/** Topbar bell with the unread attention count. Fail-open: never blocks boot. */
async function refreshBell() {
  try {
    const data = await v2api.get("/notifications");
    if (!data || typeof data.unread !== "number") return;
    const link = document.querySelector('a[href="#notifications"]');
    const host = link?.parentElement;
    if (!host || host.querySelector(".nav-badge")) return;
    if (data.unread > 0) {
      const badge = el("span", { class: "nav-badge", text: String(data.unread), "aria-label": `${data.unread} items need attention` });
      host.append(badge);
    }
  } catch { /* notifications unavailable — the page still lists it */ }
}

/** A blank panel is the worst possible outcome, so it is never left blank. */
function showFatal(err) {
  if (!shell) return;
  mount(shell.content, el("div", { class: "list-panel" },
    el("div", { class: "table-state table-state-error" },
      el("p", { class: "table-state-title", text: "This screen failed to load" }),
      el("p", { class: "muted", text: err?.message || String(err) }),
      el("button", {
        class: "button", type: "button", text: "Try again",
        onclick: () => window.location.reload(),
      }))));
  console.error("[admin]", err);
}

boot();
