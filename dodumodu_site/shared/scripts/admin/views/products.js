import { el, mount, formatNaira, formatDateTime, toWireTimestamp } from "../dom.js";
import { api, ApiError, qs } from "../api.js";
import {
  adminTable, adminSearch, adminFilters, adminPagination, resultCount, adminField,
  fieldset, saveBar, readForm, applyFieldErrors, actionButtons, statusBadge, toast,
  toastError, openModal, confirmDialog, definitionList, errorState, adminImageUploader,
  listScaffold,
  adminImagePicker,
} from "../ui.js";
import { mountDeploymentStatus, mountStatusUnavailable } from "../deployStatus.js";

// Products.
//
// Two behaviours are worth calling out.
//
// The detail screen is ONE request. The server returns product, category, images,
// page content, latest publish and the order count together, so opening a product
// editor is one round trip rather than five sequential ones - which is what an N+1
// looks like from the operator's side, as a spinner.
//
// Archive is not delete. A product that has ever sold cannot be removed without
// destroying the record of what was bought, so DELETE /products/:id sets
// active = false. The button says "Archive" so nobody expects a row to vanish.

export function productsView({ shell, identity, onNavigate }) {
  const state = { page: 1, pageSize: 50, q: "", categoryId: "", active: "" };
  let host;
  let ui;
  let controlsBuilt = false;
  let categories = [];

  const can = (permission) => (identity?.permissions || []).includes(permission);

  async function load() {
    try {
      // The category list feeds the FILTER, not the rows, so it is fetched outside
      // the scaffold's cancellation: cancelling it mid-search would empty a dropdown
      // the operator is using.
      const cats = api.get("/categories?pageSize=100").catch(() => ({ categories: [] }));
      const data = await ui.load((signal) => api.get(`/products${qs({
        q: state.q, categoryId: state.categoryId, active: state.active,
        page: state.page, pageSize: state.pageSize,
      })}`, signal), { pending: "Loading products…" });
      if (!data) return;
      categories = (await cats).categories || [];
      buildControls();
      render(data);
    } catch (err) {
      ui.results(errorState(err, load));
    }
  }

  /**
   * Populated once, after the first load, and never rebuilt.
   *
   * The category dropdown cannot be built before that load because its options ARE
   * the response - which is exactly why it used to be rebuilt on every render, and
   * why the search box kept closing. Waiting for the options and then building once
   * gives a populated dropdown that persists.
   */
  function buildControls() {
    if (controlsBuilt) return;
    controlsBuilt = true;
    mount(ui.controls,
      adminSearch({
        value: state.q, placeholder: "Search name or slug",
        onSearch: (value) => { state.q = value; state.page = 1; load(); },
      }),
      adminFilters({
        value: { categoryId: state.categoryId, active: state.active },
        filters: [
          { key: "categoryId", label: "Category", options: categories.map((c) => ({ value: c.id, label: c.name })) },
          { key: "active", label: "State", options: [
            { value: "true", label: "Active" },
            { value: "false", label: "Archived" },
          ] },
        ],
        onChange: (next) => {
          state.categoryId = next.categoryId || "";
          state.active = next.active || "";
          state.page = 1;
          load();
        },
      }));
  }

  function render({ products, page }) {
    const showView = can("products:read"); // view storefront is a read-level action
    ui.results(
      el("div", { class: "list-summary" }, resultCount({ page, noun: "product" })),
      adminTable({
        caption: "Products",
        rows: products,
        rowKey: (row) => row.id,
        onRowClick: (row) => openDetail(row.id),
        empty: products.length === 0
          ? {
              title: "No products yet",
              body: "Create your first product to add it to the storefront.",
              action: can("products:write")
                ? el("button", {
                    class: "button button-primary",
                    type: "button",
                    text: "+ Add product",
                    onclick: () => openForm(null),
                  })
                : null,
            }
          : undefined,
        columns: [
          { label: "Name", render: ({ row }) => el("div", { class: "stack" },
            el("span", { class: "strong", text: row.name }),
            el("code", { class: "reference", text: row.slug })) },
          { label: "Category", render: ({ row }) => (row.categoryName
            ? el("span", { text: row.categoryName })
            : el("span", { class: "muted", text: "Uncategorised" })) },
          { label: "Price", className: "col-num", render: ({ row }) => formatNaira(row.price) },
          { label: "State", render: ({ row }) => statusBadge(row.active ? "active" : "inactive", row.active ? "Active" : "Archived") },
          { label: "Publish", className: "col-num", render: ({ row }) => {
            if (!row.latestPublish) {
              return el("span", { class: "badge badge-neutral", text: "Not published" });
            }
            const status = row.latestPublish.buildStatus ?? "pending";
            const label = status === "pending" ? "Awaiting deploy"
              : status === "triggered" ? "Deploying"
              : status === "failed" ? "Deploy failed"
              : "Published";
            return statusBadge(
              status === "failed" ? "failed" : status === "triggered" ? "triggered" : "active",
              label);
          }},
          { label: "Updated", className: "col-when", render: ({ row }) => el("span", { class: "nowrap", text: formatDateTime(row.updatedAt) }) },
          { label: "Actions", className: "col-actions", render: ({ row }) => actionButtons([
            { label: "Edit", onSelect: () => openForm(row) },
            row.latestPublish && showView
              ? { label: "View storefront", onSelect: () => { window.open(`/${row.slug}/`, "_blank"); } }
              : null,
            ...(can("products:write") && row.active
              ? [{ label: "Archive", danger: true, onSelect: () => archive(row) }]
              : []),
          ].filter(Boolean)) },
        ],
      }),
      adminPagination({
        page,
        onPage: (n) => { state.page = n; load(); },
        onPageSize: (n) => { state.pageSize = n; state.page = 1; load(); },
      }));
  }

  /* ---- one-request detail ---- */

  async function openDetail(id) {
    let detail;
    try {
      detail = await api.get(`/products/${id}`);
    } catch (err) {
      toastError(err);
      return null;
    }
    const { product, category, images, page, latestPublish, orderCount } = detail;
    // The observed deployment status is fetched separately and rendered into its
    // own host, so the panel never blocks the detail view and never blocks ON the
    // detail view: a slow verification must not delay the editor opening.
    const deploymentHost = el("div", { class: "deploy-host" });
    loadDeploymentStatus(product, deploymentHost);
    return openModal({
      title: product.name,
      render: (close) => el("div", { class: "detail" },
        el("div", { class: "detail-header" },
          statusBadge(product.active ? "active" : "inactive", product.active ? "Active" : "Archived"),
          el("code", { class: "reference", text: product.slug })),

        definitionList([
          ["Category", category ? category.name : el("span", { class: "muted", text: "Uncategorised" })],
          ["Price", formatNaira(product.price)],
          ["Packages", (product.packageOptions || []).length
            ? el("ul", { class: "dialog-list" }, product.packageOptions.map((p) => el("li", { text: `${p.label} — ${formatNaira(p.price ?? product.price)}` })))
            : el("span", { class: "muted", text: "None" })],
          ["Description", product.description],
          ["Orders", String(orderCount)],
          ["Images", String(images.length)],
        ]),

        el("h3", { class: "detail-heading", text: "Page content" }),
        // Draft is not published. Conflating the two is how an admin edits a page
        // and then wonders why nothing changed for customers.
        definitionList([
          ["Summary", page?.summaryHtml
            ? el("span", { text: "Written" })
            : el("span", { class: "muted", text: "Not written yet (defaults are used)" })],
          ["Benefits", String((page?.benefits || []).length)],
          ["How to use", String((page?.howToUse || []).length)],
          ["FAQ", String((page?.faq || []).length)],
        ]),

        el("h3", { class: "detail-heading", text: "Latest publish" }),
        deploymentHost,
        latestPublish
          ? definitionList([
            ["Published", formatDateTime(latestPublish.createdAt)],
            ["By", latestPublish.publishedBy],
          ])
          : el("p", { class: "muted", text: "This product has never been published." }),

        el("div", { class: "detail-actions" },
          el("button", { class: "button button-primary", type: "button", text: "Edit product", onclick: () => { close(); openForm(product); } }),
          el("button", { class: "button", type: "button", text: "Images", onclick: () => { close(); openImages(product); } }),
          el("button", { class: "button", type: "button", text: "Edit page content", onclick: () => { close(); openPageContent(product); } }),
          el("button", { class: "button", type: "button", text: "Publish…", onclick: () => { close(); openPublish(product); } }),
          // Offered only when there is a snapshot and the last attempt did not reach
          // Cloudflare. It re-fires the deploy against the SAME snapshot, so retrying
          // can never change what customers will receive.
          latestPublish && latestPublish.buildStatus === "failed"
            ? el("button", {
              class: "button button-danger", type: "button", text: "Rebuild storefront",
              title: "Ask Cloudflare to rebuild the site from the last published snapshot",
              onclick: () => { close(); retryDeploy(product); },
            })
            : null,
          el("button", { class: "button", type: "button", text: "Close", onclick: close }))),
    });
  }

  function openForm(existing) {
    const isNew = !existing;
    const product = existing || {
      slug: "", name: "", description: "", price: 0, categoryId: null, active: true,
      packageOptions: [], seoTitle: "", seoDescription: "",
    };
    const body = el("div");
    const modal = openModal({ title: isNew ? "Add product" : `Edit ${product.name}`, render: () => body });

    const form = el("form", { class: "form", onsubmit: (e) => e.preventDefault() },
      fieldset({ legend: "Product", fields: [
        adminField({ name: "name", label: "Name", value: product.name }),
        adminField({ name: "slug", label: "URL slug", value: product.slug, hint: "Lowercase letters, numbers and single dashes." }),
        adminField({ name: "description", label: "Description", value: product.description, type: "textarea", rows: 4 }),
      ] }),
      fieldset({ legend: "Pricing and placement", columns: 2, fields: [
        // Kobo, not naira: the server stores integers, and a decimal in this box
        // would be a rounding rule invented in the browser.
        adminField({ name: "price", label: "Price (kobo)", type: "number", value: product.price, min: 1, step: 1, hint: "₦15,000 is 1500000." }),
        adminField({
          name: "categoryId", label: "Category", type: "select", value: product.categoryId ?? "",
          options: [{ value: "", label: "— none —" }, ...categories.map((c) => ({ value: c.id, label: c.name }))],
        }),
        adminField({ name: "active", label: "Active (visible on the storefront)", type: "checkbox", value: product.active !== false }),
      ] }),
      fieldset({ legend: "Search engine listing", columns: 2, fields: [
        adminField({ name: "seoTitle", label: "SEO title", value: product.seoTitle || "" }),
        adminField({ name: "seoDescription", label: "SEO description", value: product.seoDescription || "", type: "textarea" }),
      ] }),
      isNew ? null : el("p", { class: "form-note" },
        "Changing the price affects only NEW orders. Every order already placed keeps the price, discount and total it was created with."),
      saveBar({
        saveLabel: isNew ? "Create product" : "Save changes",
        onCancel: () => modal.close(),
        onSave: async () => {
          const values = readForm(form);
          const payload = {
            name: values.name,
            slug: values.slug,
            description: values.description,
            price: Number(values.price),
            categoryId: values.categoryId ? Number(values.categoryId) : null,
            packageOptions: product.packageOptions || [],
            seoTitle: values.seoTitle || null,
            seoDescription: values.seoDescription || null,
            active: values.active,
          };
          try {
            if (isNew) {
              const { product: created } = await api.post("/products", payload);
              toast(`Product “${created.name}” created`, "success");
              modal.close();
              load();
            } else {
              await api.patch(`/products/${product.id}`, {
                ...payload, expectedUpdatedAt: toWireTimestamp(product.updatedAt),
              });
              toast("Product updated", "success");
              modal.close();
              load();
            }
          } catch (err) {
            if (err instanceof ApiError && err.isValidation && err.fields) {
              applyFieldErrors(form, err.fields);
              return;
            }
            if (err instanceof ApiError && err.isConflict) {
              toast(err.message, "error", 6000);
              return;
            }
            toastError(err);
          }
        },
      }));

    mount(body, form);
    return modal;
  }

  async function archive(row) {
    const ok = await confirmDialog({
      title: `Archive “${row.name}”?`,
      danger: true,
      confirmLabel: "Archive product",
      body: el("div", {},
        el("p", { text: "It will be taken off the storefront immediately." }),
        el("p", { class: "muted", text: "It is not deleted. A product is never deleted once it has been ordered, because the order history has to keep saying what was bought." })),
    });
    if (!ok) return;
    try {
      const version = encodeURIComponent(toWireTimestamp(row.updatedAt) || "");
      const result = await api.del(`/products/${row.id}?expectedUpdatedAt=${version}`);
      toast(`“${row.name}” archived (${result.orderCount} order${result.orderCount === 1 ? "" : "s"} kept)`, "success");
      load();
    } catch (err) {
      toastError(err);
    }
  }

  /* ---- page content: draft, and the publish that makes it live ---- */

  function openPageContent(product) {
    const body = el("div", { class: "table-state" },
      el("div", { class: "spinner", "aria-hidden": "true" }),
      el("p", { class: "muted", text: "Loading page content…" }));
    const modal = openModal({ title: `Page content — ${product.name}`, render: () => body });

    api.get(`/products/${product.id}/page`).then(({ page }) => {
      const content = page || {};
      const form = el("form", { class: "form", onsubmit: (e) => e.preventDefault() },
        el("p", { class: "form-note" },
          "This is a DRAFT. Nothing here reaches a customer until you publish, and publishing captures an immutable snapshot rather than changing what is on screen."),
        fieldset({ legend: "Headlines", columns: 2, fields: [
          adminField({ name: "whyLoveTitle", label: "“Why love it” heading", value: content.whyLoveTitle || "" }),
          adminField({ name: "howToUseTitle", label: "“How to use” heading", value: content.howToUseTitle || "" }),
          adminField({ name: "ratingValue", label: "Rating", value: content.ratingValue || "" }),
          adminField({ name: "ratingCount", label: "Review count", value: content.ratingCount || "" }),
        ] }),
        fieldset({ legend: "Copy", fields: [
          // The server sanitises this to a short allowlist of inline tags, so
          // formatting survives and everything else is dropped. The hint says so,
          // because "my <div> disappeared" otherwise looks like a bug.
          adminField({
            name: "summaryHtml", label: "Summary", type: "textarea", rows: 5,
            value: content.summaryHtml || "",
            hint: "Basic formatting only: bold, italic and line breaks are kept. Other tags are removed on the server.",
          }),
          adminField({ name: "ctaText", label: "Button text", value: content.ctaText || "" }),
          adminField({ name: "heroAlt", label: "Hero image alt text", value: content.heroAlt || "", hint: "Read aloud by screen readers when the image fails." }),
          adminField({ name: "deliveryBadge", label: "Delivery badge", value: content.deliveryBadge || "" }),
        ] }),
        saveBar({
          saveLabel: "Save draft",
          onCancel: () => modal.close(),
          onSave: async () => {
            const values = readForm(form);
            try {
              await api.put(`/products/${product.id}/page`, {
                summaryHtml: values.summaryHtml,
                whyLoveTitle: values.whyLoveTitle,
                howToUseTitle: values.howToUseTitle,
                ratingValue: values.ratingValue,
                ratingCount: values.ratingCount,
                ctaText: values.ctaText,
                heroAlt: values.heroAlt,
                deliveryBadge: values.deliveryBadge,
              });
              toast("Draft saved. It is live once you publish.", "success", 5000);
              modal.close();
            } catch (err) {
              if (err instanceof ApiError && err.isValidation && err.fields) {
                applyFieldErrors(form, err.fields);
                return;
              }
              toastError(err);
            }
          },
        }));
      mount(body, form);
    }).catch((err) => mount(body, errorState(err, () => modal.close())));

    return modal;
  }

  /**
   * Publishing takes no body at all: the snapshot is assembled from the rows. This
   * dialog exists only because a publish reaches customers, and "are you sure" is
   * warranted for that in a way it is not for saving a draft.
   */
  /**
 * What the operator is told after a publish, and why the two states are worded
 * separately.
 *
 * The publish SUCCEEDED in both branches. The only thing that differs is whether
 * Cloudflare accepted the rebuild request. Saying "publish failed" after a deploy
 * failure would be a lie about the durable artefact - the snapshot exists and is
 * correct - and it would invite an operator to publish again on top of it.
 *
 * No time estimate is quoted. "Live in 1-3 minutes" is a promise nobody has
 * measured, and on a bad day it is the thing an operator holds you to.
 */
function publishOutcome(result) {
  const deployment = result?.deployment || {};
  if (deployment.status === "failed") {
    return {
      kind: "error",
      message: "Published. Storefront rebuild FAILED.",
      detail: deployment.error || "Cloudflare did not accept the rebuild request. The snapshot is safe - retry the rebuild.",
      retry: true,
    };
  }
  if (deployment.status === "pending") {
    // No deploy hook configured: local development, or a deployment that has not
    // been wired up yet. The publish is real either way.
    return {
      kind: "success",
      message: `Published (snapshot #${result.publishId}).`,
      detail: "No deploy hook is configured, so the storefront was not rebuilt. Run npm run prerender locally.",
      retry: false,
    };
  }
  return {
    kind: "success",
    message: `Published (snapshot #${result.publishId}).`,
    detail: "Storefront rebuild in progress.",
    retry: false,
  };
}

async function openPublish(product) {
    const history = await api.get(`/products/${product.id}/publishes`).catch(() => ({ publishes: [] }));
    const list = history.publishes || [];

    const ok = await confirmDialog({
      title: `Publish ${product.name}?`,
      confirmLabel: "Publish now",
      body: el("div", {},
        el("p", { text: "This captures the current draft as a new snapshot. Customers see it once the site is rebuilt." }),
        list.length
          ? el("div", {},
            el("h3", { class: "dialog-subhead", text: "Previous publishes" }),
            el("ul", { class: "dialog-list" }, list.slice(0, 5).map((entry) => el("li", {
              // The status word is spelled out rather than shown raw, because
              // "triggered" next to a date reads as "the build started" and it does
              // not mean that - it means the request was accepted.
              text: `${formatDateTime(entry.createdAt)} by ${entry.publishedBy} `
                + `— ${describeBuildStatus(entry.buildStatus)}`,
            }))))
          : el("p", { class: "muted", text: "This product has never been published." })),
    });
    if (!ok) return;

    try {
      const result = await api.post(`/products/${product.id}/publish`, {});
      const outcome = publishOutcome(result);
      toast(outcome.message, outcome.kind, 6000);
      if (outcome.detail) toast(outcome.detail, outcome.kind === "error" ? "error" : "info", 9000);
      if (outcome.retry) offerRetry(product);
      // Reopened either way: the history list is how the operator sees the status
      // they were just told about, and the detail view carries the retry button.
      load();
    } catch (err) {
      // Only reachable when the PUBLISH itself failed - the snapshot was never
      // written - which is genuinely an error and genuinely different.
      toastError(err);
    }
  }

  /** Retries only the rebuild, against the snapshot that already exists. */
  async function retryDeploy(product) {
    try {
      const result = await api.post(`/products/${product.id}/redeploy`, {});
      const outcome = publishOutcome(result);
      toast(outcome.kind === "error" ? "Rebuild failed again." : "Rebuild requested.", outcome.kind, 6000);
      if (outcome.kind === "error" && outcome.detail) toast(outcome.detail, "error", 9000);
      load();
    } catch (err) {
      toastError(err);
    }
  }

  function offerRetry(product) {
    toast("Use “Rebuild storefront” on this product to try again.", "info", 8000);
    void product;
  }

  /**
 * Fetches the OBSERVED deployment status and mounts it.
 *
 * The fetch goes to the API, which in turn fetches the public storefront. So this
 * panel is never showing what the panel itself inferred - it is showing what a
 * customer would actually receive.
 */
async function loadDeploymentStatus(product, host) {
  const refresh = () => loadDeploymentStatus(product, host);
  try {
    const status = await api.get(`/products/${product.id}/status`);
    mountDeploymentStatus(host, status, { onRetry: () => retryDeploy(product, refresh) });
  } catch {
    mountStatusUnavailable(host, refresh);
  }
}

/** Plain-English names for the four deployment states. */
  function describeBuildStatus(status) {
    switch (status) {
      case "pending": return "rebuild not started";
      // Deliberately not "building": the hook was accepted, and nothing has
      // confirmed a build has started.
      case "triggered": return "rebuild requested";
      case "deployed": return "live";
      case "failed": return "rebuild failed";
      default: return String(status ?? "unknown");
    }
  }

  /**
   * Images for one product. The uploader resizes in the browser before sending, so
   * what lands in object storage is already a sensible size rather than a 6 MB
   * phone photo.
   *
   * The list is replaced wholesale on save (PUT /products/:id/images) because an
   * image row has no id the form ever saw, so there is nothing to merge against.
   * One write path also means display order is decided in exactly one place.
   */
  async function openImages(product) {
    const body = el("div", { class: "table-state" },
      el("div", { class: "spinner", "aria-hidden": "true" }),
      el("p", { class: "muted", text: "Loading images…" }));
    const modal = openModal({ title: `Images — ${product.name}`, render: () => body });

    try {
      const detail = await api.get(`/products/${product.id}`);
      let images = (detail.images || []).map((image) => ({
        id: image.id, r2Key: image.r2Key, altText: image.altText || "", displayOrder: image.displayOrder ?? 0,
      })).sort((a, b) => a.displayOrder - b.displayOrder);

      const listHost = el("div", { class: "image-list" });

      function paint() {
        mount(listHost, images.length === 0
          ? el("p", { class: "muted", text: "No images yet. Upload one below." })
          : el("ul", { class: "image-rows" }, images.map((image, index) => el("li", { class: "image-row" },
            el("span", { class: "image-order", text: String(index + 1) }),
            el("code", { class: "reference", text: image.r2Key }),
            el("input", {
              class: "input", type: "text", value: image.altText, placeholder: "Alt text",
              "aria-label": "Alt text",
              oninput: (e) => { image.altText = e.target.value; },
            }),
            el("button", {
              class: "button button-small", type: "button", text: "↑", title: "Move up",
              disabled: index === 0,
              onclick: () => { [images[index - 1], images[index]] = [images[index], images[index - 1]]; paint(); },
            }),
            el("button", {
              class: "button button-small", type: "button", text: "↓", title: "Move down",
              disabled: index === images.length - 1,
              onclick: () => { [images[index + 1], images[index]] = [images[index], images[index + 1]]; paint(); },
            }),
            el("button", {
              class: "button button-small button-danger", type: "button", text: "Remove",
              onclick: () => { images.splice(index, 1); paint(); },
            })))));
      }
      paint();

      mount(body,
        el("p", { class: "form-note" }, "Order is what customers see first. Saving replaces the whole list."),
        listHost,
        el("div", { class: "uploader-row" },
          // Two routes to the same outcome: upload a NEW file, or reuse something
          // already in the library. Without the second, every product that wanted
          // the same shot uploaded its own copy and the library filled with
          // near-duplicates while the originals sat unreferenced.
          adminImageUploader({
            productId: product.id,
            onUploaded: (media) => {
              images.push({ id: null, r2Key: media.r2Key, altText: "", displayOrder: images.length });
              paint();
              toast("Image uploaded. Remember to save.", "success");
            },
          }),
          adminImagePicker({
            title: "Reuse an uploaded image",
            max: 1,
            onSelect: ([media]) => {
              if (!media) return;
              if (images.some((image) => image.r2Key === media.r2Key)) {
                toast("That image is already on this product", "info");
                return;
              }
              images.push({ id: null, r2Key: media.r2Key, altText: "", displayOrder: images.length });
              paint();
              toast("Image added. Remember to save.", "success");
            },
          })),
        saveBar({
          saveLabel: "Save images",
          onCancel: () => modal.close(),
          onSave: async () => {
            try {
              await api.put(`/products/${product.id}/images`, {
                images: images.map((image, index) => ({
                  r2Key: image.r2Key,
                  altText: image.altText,
                  displayOrder: index,
                })),
              });
              toast("Images saved", "success");
              modal.close();
            } catch (err) {
              toastError(err);
            }
          },
        }));
    } catch (err) {
      mount(body, errorState(err, () => modal.close()));
    }

    return modal;
  }

  return {
    start() {
      host = el("div", { class: "list" });
      mount(shell.content,
        el("div", { class: "list-panel" },
          el("div", { class: "list-head" },
            el("h2", { class: "list-title", text: "All products" }),
            can("products:write")
              ? el("button", { class: "button button-primary", type: "button", text: "+ Add product", onclick: () => openForm(null) })
              : null),
          host));
      ui = listScaffold(host);
      load();
    },
  };
}
