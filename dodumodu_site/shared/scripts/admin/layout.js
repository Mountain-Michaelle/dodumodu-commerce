import { el, mount, clear } from "./dom.js";

// The shell: a header, a model list, a breadcrumb and one mount point.
//
// This is deliberately the only place that knows what the sidebar contains, and it
// holds a list of { id, label, group } rather than hard-coded markup. Adding a
// resource is one line in ROUTES plus one file, not a new <li> here as well - and
// a sidebar that has to be edited in two places is one that will be half-updated.

export const NAV = [
  { group: "Catalogue", items: [
    { id: "orders", label: "Orders" },
    { id: "categories", label: "Categories" },
    { id: "products", label: "Products" },
    { id: "media", label: "Media" },
  ] },
  { group: "Content", items: [
    { id: "testimonials", label: "Testimonials" },
    { id: "pages", label: "Product pages" },
  ] },
  { group: "Safety", items: [
    { id: "shadow", label: "Abuse (shadow)" },
    { id: "blocks", label: "Blocked" },
  ] },
  { group: "Settings", items: [
    { id: "discounts", label: "Discount tiers" },
    { id: "payment", label: "Payment rules" },
  ] },
];

const TITLES = {
  orders: ["Orders", "Every order, newest first."],
  categories: ["Categories", "How the catalogue is grouped."],
  products: ["Products", "What is sold, and where it sits."],
  media: ["Media", "Every image that has been uploaded."],
  testimonials: ["Testimonials", "Reviews and WhatsApp screenshots, per product."],
  pages: ["Product pages", "The copy a published page is built from."],
  discounts: ["Discount tiers", "Quantity discounts, applied to the next order."],
  payment: ["Payment rules", "Which states may pay on delivery, and up to how much."],
  shadow: ["Abuse (shadow)", "What the automatic checks would have done. Nothing here blocks anyone."],
  blocks: ["Blocked", "Addresses and devices currently being refused, and why."],
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

  const sidebarAside = el("aside", { class: "sidebar" }, sidebar);
  let navOpen = false;
  function setNavOpen(open) {
    navOpen = open;
    document.body.classList.toggle("nav-open", open);
    burger.setAttribute("aria-expanded", String(open));
  }

  const header = el("header", { class: "topbar" },
    burger,
    el("a", { class: "brand", href: "#orders", onclick: (e) => { e.preventDefault(); onNavigate("orders"); } },
      el("span", { class: "brand-mark", text: "D" }),
      el("span", { class: "brand-text", text: "Dodumodu" }),
      el("span", { class: "brand-section", text: "Admin" })),
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
