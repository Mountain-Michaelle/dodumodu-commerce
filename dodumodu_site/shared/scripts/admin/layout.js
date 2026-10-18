import { el, mount, clear } from "./dom.js";

// The shell: a header, a model list, a breadcrumb and one mount point.
//
// This is deliberately the only place that knows what the sidebar contains, and it
// holds a list of { id, label, group } rather than hard-coded markup. Adding a
// resource is one line in ROUTES plus one file, not a new <li> here as well - and
// a sidebar that has to be edited in two places is one that will be half-updated.

export const NAV = [
  { group: "Catalogue", items: [
    { id: "orders", label: "Orders", perm: "orders.view" },
    { id: "categories", label: "Categories", perm: "categories.view" },
    { id: "products", label: "Products", perm: "products.view" },
    { id: "media", label: "Media" },
  ] },
  { group: "Content", items: [
    { id: "testimonials", label: "Testimonials", perm: "testimonials.view" },
    { id: "pages", label: "Product pages", perm: "products.view" },
  ] },
  { group: "Safety", items: [
    { id: "shadow", label: "Abuse (shadow)", perm: "abuse.view" },
    { id: "blocks", label: "Blocked" },
  ] },
  { group: "Analytics", items: [
    { id: "reports", label: "Reports", perm: "reports.view" },
  ] },
  { group: "Team", items: [
    { id: "users", label: "Users & access", perm: "users.view" },
    { id: "authlog", label: "Auth log", perm: "authlog.view" },
    { id: "notifications", label: "Notifications" },
  ] },
  { group: "Settings", items: [
    { id: "discounts", label: "Discount tiers" },
    { id: "payment", label: "Payment rules" },
  ] },
];

const TITLES = {
  orders: ["Orders", "Every order, newest first."],
  reports: ["Reports", "Monthly delivery performance and order lifecycle."],
  categories: ["Categories", "How the catalogue is grouped."],
  products: ["Products", "What is sold, and where it sits."],
  media: ["Media", "Every image that has been uploaded."],
  testimonials: ["Testimonials", "Reviews and WhatsApp screenshots, per product."],
  pages: ["Product pages", "The copy a published page is built from."],
  discounts: ["Discount tiers", "Quantity discounts, applied to the next order."],
  payment: ["Payment rules", "Which states may pay on delivery, and up to how much."],
  shadow: ["Abuse (shadow)", "What the automatic checks would have done. Nothing here blocks anyone."],
  blocks: ["Blocked", "Addresses and devices currently being refused, and why."],
  users: ["Users & access", "Who can sign in, what each person may do, and every access change."],
  authlog: ["Auth log", "Every sign-in attempt, recovery, block and session event."],
  notifications: ["Notifications", "Lost-email requests, failed alerts and live blocks needing attention."],
};

/**
 * Builds the shell. `onNavigate(routeId)` is called by the router; the shell only
 * reports the choice and highlights whichever item is current.
 */
export function buildShell({ root, onNavigate, identity }) {
  const navLinks = new Map();
  const sidebar = el("nav", { class: "sidebar-nav", "aria-label": "Sections" },
    NAV.map((group) => el("div", { class: "nav-group" },
      el("h2", { class: "nav-group-title", text: group.group }),
      el("ul", { class: "nav-list" }, group.items.map((item) => {
        const link = el("a", {
          class: "nav-link", href: `#${item.id}`, text: item.label,
          onclick: (event) => { event.preventDefault(); onNavigate(item.id); },
        });
        navLinks.set(item.id, link);
        return el("li", {}, link);
      })))));

  const crumb = el("div", { class: "breadcrumb" });
  const heading = el("h1", { class: "page-title" });
  const subtitle = el("p", { class: "page-subtitle" });
  const toolbar = el("div", { class: "page-toolbar" });
  const content = el("div", { class: "page-content" });
  const scrim = el("div", { class: "nav-scrim", onclick: () => setNavOpen(false) });

  const burger = el("button", {
    class: "nav-burger", type: "button", "aria-label": "Open navigation", "aria-expanded": "false",
    onclick: () => setNavOpen(!navOpen),
  }, el("span", { class: "burger-line" }), el("span", { class: "burger-line" }), el("span", { class: "burger-line" }));

  // The sidebar's brand head: the company logo — the same still drawing as the
  // splash (cart + wheels + speed lines, navy on the white panel). Not a link:
  // the topbar logo already handles navigation, so this would be a duplicate
  // target; it exists to make the left panel recognisably DODUMODU's.
  const sidebarAside = el("aside", { class: "sidebar" },
    el("div", { class: "dm-side-brand" },
      el("svg", { class: "dm dm-side", viewBox: "1 -16 2030 504", width: "176", height: "44", "aria-hidden": "true", "focusable": "false", html: '<use href="#dm-logo"/>' }),
      el("span", { class: "dm-vh", text: "DODUMODU" })),
    sidebar);
  let navOpen = false;
  function setNavOpen(open) {
    navOpen = open;
    document.body.classList.toggle("nav-open", open);
    burger.setAttribute("aria-expanded", String(open));
  }

  const header = el("header", { class: "topbar" },
    burger,
    el("a", { class: "dm-topbar-logo", href: "#orders", onclick: (e) => { e.preventDefault(); onNavigate("orders"); } },
      el("svg", { class: "dm dm-bar", viewBox: "1 -16 2030 504", width: "170", height: "42", "data-dm-bar": "true", "aria-hidden": "true", "focusable": "false", html: '<g transform="translate(750 441)"><g class="dm-b"><use href="#dm-b" x="-750" y="-441"/></g></g><g transform="translate(456 346)"><use class="dm-r" href="#dm-o"/></g><g transform="translate(1670 346)"><use class="dm-r" href="#dm-o"/></g><g class="dm-s" fill="none" stroke="url(#dm-f)" stroke-width="14" stroke-linecap="round"><g transform="translate(1709 199)"><path d="M0 0h248"/></g><g transform="translate(1796 261)"><path d="M0 0h125"/></g><g transform="translate(1820 323)"><path d="M0 0h203"/></g><g transform="translate(1817 385)"><path d="M0 0h158"/></g><g transform="translate(1784 447)"><path d="M0 0h86"/></g></g>' }),
      el("span", { class: "dm-vh", text: "DODUMODU admin" })),
    el("div", { class: "topbar-right" },
      el("a", { class: "topbar-link", href: "/", text: "View store ↗" }),
      identity ? el("span", { class: "topbar-user", title: identity.email, text: identity.email }) : null));

  mount(root,
    header,
    scrim,
    el("div", { class: "shell-body" },
      sidebarAside,
      el("main", { class: "main" },
        el("div", { class: "page-head" }, crumb, heading, subtitle, toolbar),
        content)));

  return {
    content,
    toolbar,
    /** The human title for a route, so the breadcrumb can use the same words. */
    titleFor(id) {
      return (TITLES[id] || [id])[0];
    },
    /** Points the header at a route. `trail` is an optional [{label, id}] path. */
    setRoute(id, trail) {
      for (const [key, link] of navLinks) link.classList.toggle("is-active", key === id);
      const [title, sub] = TITLES[id] || [id, ""];
      heading.textContent = title;
      subtitle.textContent = sub || "";
      mount(crumb, trail && trail.length
        ? trail.flatMap((step, index) => [
          index > 0 ? el("span", { class: "crumb-sep", text: "/" }) : null,
          step.id && index < trail.length - 1
            ? el("a", { class: "crumb", href: `#${step.id}`, text: step.label, onclick: (e) => { e.preventDefault(); onNavigate(step.id); } })
            : el("span", { class: "crumb is-current", text: step.label }),
        ])
        : [el("span", { class: "crumb is-current", text: title })]);
      setNavOpen(false);
      clear(content);
    },
    closeNav: () => setNavOpen(false),
  };
}
