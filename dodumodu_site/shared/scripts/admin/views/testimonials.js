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
// networks, and a supplied photo renders as a large picture card on the storefront.
//
// Paging is SERVER-side (page/pageSize on /admin/testimonials) through the same
// scaffold and paginator every other list uses: a testimonial table that grows
// past one screen must not turn into an unbounded download.

export function testimonialsView({ shell, identity }) {
  let host;
  let products = [];
  let ui;
  const state = { page: 1, pageSize: 20 };
  let shotCounts = {}; // visible WhatsApp screenshots per product, from the server
  let maxShots = 5;

  const can = (permission) => (identity?.permissions || []).includes(permission);

  async function load() {
    try {
      const data = await ui.load((signal) => api.get(`/testimonials${qs({
        page: state.page, pageSize: state.pageSize,
      })}`, signal), { pending: "Loading testimonials…" });
      if (!data) return;
      shotCounts = data.screenshotCounts || {};
      maxShots = data.maxScreenshots || 5;
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

    // WhatsApp screenshots: one row per image. A NEW screenshot testimonial takes up to MAX_SHOTS images at once (the product page
    // shows at most 5 of them in its WhatsApp section; the server enforces that too); editing one row changes that one image.
    // How many images this form may hold = the product's 5, minus the screenshots it already shows from OTHER rows. So with
    // one screenshot saved you can add up to four more; with five you can only change them.
    const productKey = () => String(item.productId || (products.length === 1 ? products[0].id : ""));
    const ownsVisibleShot = () => Boolean(existing && existing.kind === "whatsapp" && existing.active && String(existing.productId) === productKey());
    const shotLimit = () => Math.max(1, maxShots - ((shotCounts[productKey()] || 0) - (ownsVisibleShot() ? 1 : 0)));
    const shots = existing && existing.r2Key && existing.kind === "whatsapp"
      ? [{ r2Key: existing.r2Key, width: existing.width || null, height: existing.height || null }] : [];
    const imageField = el("div", { class: "field-row" });
    function paintImageRow() {
      const isScreenshot = item.kind === "whatsapp";
      if (isScreenshot) {
        const room = shotLimit() - shots.length;
        const toShot = (media, dims) => ({ r2Key: media.r2Key, width: dims?.width || media.width || null, height: dims?.height || media.height || null });
        mount(imageField,
          el("div", { class: "field" },
            el("span", { class: "field-label", text: `Screenshot images (${shots.length} of up to ${shotLimit()} for this product)` }),
            el("div", { class: "shot-list" }, ...shots.map((shot, i) => el("div", { class: "uploader-row" },
              el("div", { class: "image-preview" }, el("img", { class: "picker-thumb", src: `${imageBase()}/${shot.r2Key}`, alt: "", loading: "lazy" })),
              // Change: replace THIS image with another upload.
              adminImageUploader({ label: "Change image", onUploaded: (media, dims) => { shots[i] = toShot(media, dims); paintImageRow(); } }),
              (isNew || i > 0) ? el("button", { class: "button button-small", type: "button", text: "Remove", onclick: () => { shots.splice(i, 1); paintImageRow(); } }) : null))),
            room > 0
              ? el("div", { class: "uploader-row" },
                adminImageUploader({
                  max: room,
                  label: shots.length ? "Upload more images…" : (shotLimit() > 1 ? "Choose images…" : "Choose image…"),
                  onUploaded: (media, dims) => { if (shots.length < shotLimit()) { shots.push(toShot(media, dims)); paintImageRow(); } },
                }),
                adminImagePicker({
                  label: "Reuse uploaded images", title: "Choose the testimonial screenshots", max: room,
                  onSelect: (picked) => { for (const m of picked || []) if (m && shots.length < shotLimit()) shots.push(toShot(m)); paintImageRow(); },
                }))
              : null,
            el("p", { class: "field-error", dataset: { errorFor: "r2Key" } }),
            el("span", {
              class: "hint",
              text: "Required. Each image is its own screenshot in the “Real WhatsApp messages” section after the written reviews, no quote needed; the title is only a label (and the screen-reader description).",
            })));
        return;
      }
      // A written review takes an OPTIONAL photo (shown large beside / above the text). A text-only review renders its
      // initial-letter tile instead, so it stays cheap on weak networks.
      mount(imageField,
        el("div", { class: "field" },
          el("span", { class: "field-label", text: "Review photo (optional)" }),
          el("div", { class: "uploader-row" },
            item.r2Key
              ? el("div", { class: "image-preview" },
                el("img", { class: "picker-thumb", src: `${imageBase()}/${item.r2Key}`, alt: "", loading: "lazy" }))
              : el("span", { class: "muted", text: "No image chosen" }),
            adminImageUploader({
              label: item.r2Key ? "Change image" : "Choose image…",
              onUploaded: (media) => { item.r2Key = media.r2Key; paintImageRow(); },
            }),
            adminImagePicker({
              label: "Reuse an uploaded image",
              title: "Choose the review photo",
              max: 1,
              onSelect: ([media]) => { if (media) { item.r2Key = media.r2Key; paintImageRow(); } },
            }),
            item.r2Key ? el("button", { class: "button button-small", type: "button", text: "Remove", onclick: () => { item.r2Key = ""; paintImageRow(); } }) : null),
          el("p", { class: "field-error", dataset: { errorFor: "r2Key" } }),
          el("span", { class: "hint", text: "Optional. Shown large beside (desktop) or above (phone) the text. Leave empty for a text-only review." })));
    }
    paintImageRow();

    // A screenshot carries no written text, so its quote box is hidden (and sent empty).
    const quote = adminField({ name: "description", label: "Quote", value: item.description, type: "textarea", rows: 4 });
    quote.hidden = item.kind === "whatsapp";
    const form = el("form", { class: "form", onsubmit: (e) => e.preventDefault() },
      fieldset({ legend: "Testimonial", fields: [
        adminField({ name: "title", label: "Title", value: item.title }),
        quote,
      ] }),
      fieldset({ legend: "Placement", columns: 2, fields: [
        adminField({
          name: "kind", label: "Kind", type: "select", value: item.kind,
          options: [{ value: "review", label: "Written review" }, { value: "whatsapp", label: "WhatsApp screenshot" }],
          onInput: (e) => { item.kind = e.target.value; quote.hidden = item.kind === "whatsapp"; paintImageRow(); },
        }),
        adminField({
          name: "productId", label: "Product", type: "select", value: item.productId ?? "",
          options: [{ value: "", label: "— none —" }, ...products.map((p) => ({ value: p.id, label: p.name }))],
          onInput: (e) => { item.productId = e.target.value; if (item.kind === "whatsapp") paintImageRow(); },
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
          const base = {
            title: values.title,
            kind: values.kind,
            // Left out (not null) when no product is chosen: the server then uses the only product, or says which is needed.
            ...(values.productId ? { productId: Number(values.productId) } : {}),
            displayOrder: Number(values.displayOrder) || 0,
            active: values.active,
          };
          const isShot = values.kind === "whatsapp";
          if (isShot && !shots.length) { applyFieldErrors(form, { r2Key: ["A WhatsApp screenshot needs an uploaded image"] }); return; }
          const payloads = isShot
            ? shots.map((shot) => ({ ...base, description: "", r2Key: shot.r2Key, ...(shot.width && shot.height ? { width: shot.width, height: shot.height } : {}) }))
            : [{ ...base, description: values.description, r2Key: item.r2Key }];
          let saved = 0;
          try {
            for (const [i, payload] of payloads.entries()) {
              // Editing: the first image updates this row; any ADDED images become new screenshot rows.
              if (isNew || i > 0) await api.post("/testimonials", payload);
              else await api.put(`/testimonials/${item.id}`, payload);
              saved += 1;
            }
            toast(saved > 1 ? `${saved} screenshots saved` : "Testimonial saved", "success");
            modal.close();
            load();
          } catch (err) {
            if (saved) {
              // Some images are already saved: close and reload so pressing save again cannot create duplicates.
              modal.close(); load();
              toast(`${saved} saved, the rest were not: ${err?.message || err}`, "error", 8000);
              return;
            }
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
