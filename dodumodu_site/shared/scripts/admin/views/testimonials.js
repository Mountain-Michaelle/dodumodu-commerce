import { el, mount } from "../dom.js";
import { api, ApiError, qs } from "../api.js";
import {
  adminTable, adminPagination, adminField, fieldset, saveBar, readForm, applyFieldErrors,
  actionButtons, statusBadge, toast, toastError, openModal, errorState, adminImageUploader,
  adminImagePicker, imageBase, resultCount, listScaffold,
} from "../ui.js";

// Testimonials. Product-scoped, because a page must never show a review that
// belongs to a different product.
//
// The `kind` distinction is the rule with teeth: a WhatsApp screenshot without an
// image renders a broken frame on a live product page, so the server refuses it.
// A written review takes an OPTIONAL photo: text-only cards stay cheap on weak
// networks, and a supplied photo renders as the 64px avatar on the storefront.
//
// Paging is SERVER-side (page/pageSize on /admin/testimonials) through the same
// scaffold and paginator every other list uses: a testimonial table that grows
// past one screen must not turn into an unbounded download.

export function testimonialsView({ shell, identity }) {
  let host;
  let products = [];
  let ui;
  const state = { page: 1, pageSize: 20 };

  const can = (permission) => (identity?.permissions || []).includes(permission);

  async function load() {
    try {
      const data = await ui.load((signal) => api.get(`/testimonials${qs({
        page: state.page, pageSize: state.pageSize,
      })}`, signal), { pending: "Loading testimonials…" });
      if (!data) return;
      render(data);
    } catch (err) {
      ui.results(errorState(err, load));
    }
  }

  function render({ testimonials, page }) {
    ui.results(
      el("div", { class: "list-summary" }, resultCount({ page, noun: "testimonial" })),
      adminTable({
        caption: "Testimonials",
        rows: testimonials || [],
        rowKey: (row) => row.id,
        onRowClick: (row) => openForm(row),
        columns: [
          { label: "Title", render: ({ row }) => el("span", { class: "strong", text: row.title }) },
          { label: "Kind", render: ({ row }) => statusBadge(row.kind === "whatsapp" ? "unprocessed" : "active", row.kind === "whatsapp" ? "Screenshot" : "Review") },
          { label: "Product", render: ({ row }) => (row.productId
            ? el("span", { text: (products.find((p) => p.id === row.productId) || {}).name || `#${row.productId}` })
            : el("span", { class: "muted", text: "None" })) },
          { label: "Image", render: ({ row }) => el("span", { class: "muted", text: row.r2Key ? "Yes" : "No" }) },
          { label: "Order", className: "col-num", render: ({ row }) => String(row.displayOrder ?? 0) },
          { label: "State", render: ({ row }) => statusBadge(row.active ? "active" : "inactive", row.active ? "Visible" : "Hidden") },
          { label: "Actions", className: "col-actions", render: ({ row }) => actionButtons([
            { label: "Edit", onSelect: () => openForm(row) },
          ]) },
        ],
      }),
      adminPagination({
        page,
        pageSizeOptions: [20, 50, 100],
        onPage: (n) => { state.page = n; load(); },
        onPageSize: (n) => { state.pageSize = n; state.page = 1; load(); },
      }));
  }

  function openForm(existing) {
    const isNew = !existing;
    const item = existing || {
      title: "", description: "", kind: "review", r2Key: "", productId: "", displayOrder: 0, active: true,
    };
    const body = el("div");
    const modal = openModal({ title: isNew ? "Add testimonial" : `Edit “${item.title}”`, render: () => body });

    // The image row exists only for a screenshot - the one kind that needs one. The
    // server enforces that regardless, so this is clarity, not the control.
    const imageField = el("div", { class: "field-row" });
    function paintImageRow() {
      // One uploader for both kinds: required for a WhatsApp screenshot (the
      // server refuses a screenshot without one — a broken frame on a live
      // product page), OPTIONAL for a written review, where the photo becomes
      // the small avatar beside the quote. A text-only review renders its
      // initial-letter tile instead, so it stays cheap on weak networks.
      const isScreenshot = item.kind === "whatsapp";
      mount(imageField,
        el("div", { class: "field" },
          el("span", { class: "field-label", text: isScreenshot ? "Screenshot image" : "Review photo (optional)" }),
          el("div", { class: "uploader-row" },
            // Showing the storage key told an operator an image was set and gave them
            // no way to change it except uploading a duplicate. Now the current
            // image is visible, and both routes to a new one - upload a file, or
            // reuse one already uploaded.
            item.r2Key
              ? el("div", { class: "image-preview" },
                el("img", { class: "picker-thumb", src: `${imageBase()}/${item.r2Key}`, alt: "", loading: "lazy" }))
              : el("span", { class: "muted", text: "No image chosen" }),
            adminImageUploader({
              onUploaded: (media) => { item.r2Key = media.r2Key; paintImageRow(); },
            }),
            // max 1: a screenshot testimonial has exactly one image, so choosing
            // replaces rather than adds.
            adminImagePicker({
              label: "Reuse an uploaded image",
              title: "Choose the testimonial screenshot",
              max: 1,
              onSelect: ([media]) => { if (media) { item.r2Key = media.r2Key; paintImageRow(); } },
            }),
            item.r2Key ? el("button", { class: "button button-small", type: "button", text: "Remove", onclick: () => { item.r2Key = ""; paintImageRow(); } }) : null),
          el("p", { class: "field-error", dataset: { errorFor: "r2Key" } }),
          el("span", {
            class: "hint",
            text: isScreenshot
              ? "A screenshot testimonial must have an image, or the product page renders a broken frame."
              : "Optional. Leave empty for a text-only review — nothing breaks, and the card stays light on slow networks.",
          })));
    }
    paintImageRow();

    const form = el("form", { class: "form", onsubmit: (e) => e.preventDefault() },
      fieldset({ legend: "Testimonial", fields: [
        adminField({ name: "title", label: "Title", value: item.title }),
        adminField({ name: "description", label: "Quote", value: item.description, type: "textarea", rows: 4 }),
      ] }),
      fieldset({ legend: "Placement", columns: 2, fields: [
        adminField({
          name: "kind", label: "Kind", type: "select", value: item.kind,
          options: [{ value: "review", label: "Written review" }, { value: "whatsapp", label: "WhatsApp screenshot" }],
          onInput: (e) => { item.kind = e.target.value; paintImageRow(); },
        }),
        adminField({
          name: "productId", label: "Product", type: "select", value: item.productId ?? "",
          options: [{ value: "", label: "— none —" }, ...products.map((p) => ({ value: p.id, label: p.name }))],
        }),
        adminField({ name: "displayOrder", label: "Order", type: "number", value: item.displayOrder ?? 0, min: 0, step: 1 }),
        adminField({ name: "active", label: "Visible", type: "checkbox", value: item.active !== false }),
      ] }),
      imageField,
      saveBar({
        saveLabel: isNew ? "Create testimonial" : "Save changes",
        onCancel: () => modal.close(),
        onSave: async () => {
          const values = readForm(form);
          const payload = {
            title: values.title,
            description: values.description,
            kind: values.kind,
            r2Key: item.r2Key,
            productId: values.productId ? Number(values.productId) : null,
            displayOrder: Number(values.displayOrder) || 0,
            active: values.active,
          };
          try {
            if (isNew) await api.post("/testimonials", payload);
            else await api.put(`/testimonials/${item.id}`, payload);
            toast("Testimonial saved", "success");
            modal.close();
            load();
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
    return modal;
  }

  return {
    start() {
      host = el("div");
      mount(shell.content,
        el("div", { class: "list-panel" },
          el("div", { class: "list-head" },
            el("h2", { class: "list-title", text: "Testimonials" }),
            can("products:write")
              ? el("button", { class: "button button-primary", type: "button", text: "+ Add testimonial", onclick: () => openForm(null) })
              : null),
          host));
      // Persistent scaffold like every other list: the paginator lives in
      // ui.results and is swapped per page without rebuilding anything above it.
      ui = listScaffold(host);
      // No search or filters on this list yet - an empty control bar would be a
      // decorated dead zone, so it is removed (same as the reports view).
      ui.controls.remove();
      // The product dropdown inside the form still needs the full product list.
      api.get("/products?pageSize=100").then((prods) => { products = prods.products || []; }).catch(() => {});
      load();
    },
  };
}
