import { el, mount, formatDateTime, toWireTimestamp } from "../dom.js";
import { api, ApiError, qs } from "../api.js";
import {
  adminTable, adminSearch, adminFilters, adminPagination, resultCount, adminField,
  fieldset, saveBar, readForm, applyFieldErrors, actionButtons, statusBadge, toast,
  toastError, openModal, confirmDialog, errorState, bulkBar, listScaffold,
  adminImageUploader, adminImagePicker, imageBase,
} from "../ui.js";

// Categories.
//
// The delete rule is the interesting one and it lives on the server: a category
// with products or children in it is refused, and the refusal names what is in the
// way. This screen shows that answer rather than deciding anything itself, and it
// does not disable the delete button in advance - "you may not delete this yet" is
// a worse experience than "you pressed delete, and here is why not".

export function categoriesView({ shell, identity }) {
  const state = { page: 1, pageSize: 50, q: "", filter: "all", selected: new Set() };
  let host;
  let ui;
  let parents = [];
  let lastRows = [];
  let lastPage = null;

  const can = (permission) => (identity?.permissions || []).includes(permission);

  async function load() {
    try {
      // The tree is fetched alongside the list so the parent picker is populated
      // without a second round trip after the page has already drawn. It is
      // deliberately NOT inside the scaffold: it feeds the edit form, not this
      // list, and cancelling it with the list would throw away the picker.
      const tree = api.get("/categories/tree").catch(() => ({ tree: [] }));
      const data = await ui.load((signal) => api.get(`/categories${qs({
        q: state.q, filter: state.filter, page: state.page, pageSize: state.pageSize,
      })}`, signal), { pending: "Loading categories…" });
      if (!data) return;
      parents = flatten((await tree).tree || []);
      render(data);
    } catch (err) {
      ui.results(errorState(err, load));
    }
  }

  function flatten(nodes, depth = 0) {
    return nodes.flatMap((node) => [
      { id: node.id, label: `${"— ".repeat(depth)}${node.name}` },
      ...flatten(node.children || [], depth + 1),
    ]);
  }

  function render({ categories, page }) {
    lastRows = categories;
    lastPage = page;
    // A selection that outlives a filter change would let a bulk delete touch rows
    // the operator can no longer see.
    state.selected.clear();

    ui.results(
      el("div", { class: "list-summary" }, resultCount({ page, noun: "category", plural: "categories" })),
      adminTable({
        caption: "Categories",
        rows: categories,
        rowKey: (row) => row.id,
        onRowClick: (row) => openForm(row),
        columns: [
          { label: "", className: "col-check", render: ({ row }) => el("input", {
            type: "checkbox", "aria-label": `Select ${row.name}`,
            checked: state.selected.has(row.id),
            onchange: (event) => {
              if (event.target.checked) state.selected.add(row.id);
              else state.selected.delete(row.id);
              render({ categories: lastRows, page: lastPage });
            },
          }) },
          { label: "Name", render: ({ row }) => el("span", { class: "strong", text: row.name }) },
          { label: "Slug", render: ({ row }) => el("code", { class: "reference", text: row.slug }) },
          { label: "Products", className: "col-num", render: ({ row }) => String(row.productCount ?? 0) },
          { label: "Order", className: "col-num", render: ({ row }) => String(row.sortOrder ?? 0) },
          { label: "State", render: ({ row }) => statusBadge(row.isActive ? "active" : "inactive", row.isActive ? "Active" : "Hidden") },
          { label: "Image", render: ({ row }) => el("span", { class: "muted", text: row.mediaR2Key ? "Set" : "None" }) },
          { label: "Updated", className: "col-when", render: ({ row }) => el("span", { class: "nowrap", text: formatDateTime(row.updatedAt) }) },
          { label: "Actions", className: "col-actions", render: ({ row }) => actionButtons([
            { label: "Edit", onSelect: () => openForm(row) },
            ...(can("categories:write") ? [{ label: "Delete", danger: true, onSelect: () => remove(row) }] : []),
          ]) },
        ],
      }),
      adminPagination({
        page,
        onPage: (n) => { state.page = n; load(); },
        onPageSize: (n) => { state.pageSize = n; state.page = 1; load(); },
        extra: state.selected.size > 0 ? bulkBar({
          count: state.selected.size,
          onClear: () => { state.selected.clear(); render({ categories: lastRows, page: lastPage }); },
          actions: [{ label: "Delete selected", danger: true, onSelect: () => removeSelected() }],
        }) : null,
      }));
  }

  /**
   * One request for the whole selection. The server answers per row, and the counts
   * are shown as three numbers rather than one "done": most selections include
   * something still in use, and a single success flag would hide that.
   */
  async function removeSelected() {
    const ids = [...state.selected];
    const ok = await confirmDialog({
      title: `Delete ${ids.length} categor${ids.length === 1 ? "y" : "ies"}?`,
      danger: true,
      requireText: "DELETE",
      confirmLabel: "Delete selected",
      body: el("p", { text: "Any that still hold products or sub-categories are skipped and reported back to you." }),
    });
    if (!ok) return;

    try {
      const result = await api.post("/categories/bulk-action", { ids, action: "delete" });
      toast(`Deleted ${result.deleted.length}, skipped ${result.skipped.length}, failed ${result.errors.length}`,
        result.skipped.length || result.errors.length ? "warn" : "success", 7000);
      for (const item of result.skipped.slice(0, 4)) toast(`Skipped #${item.id}: ${item.reason}`, "warn");
      load();
    } catch (err) {
      toastError(err);
    }
  }

  function openForm(existing) {
    const isNew = !existing;
    const category = existing || {
      name: "", slug: "", description: "", parentId: null, isActive: true, sortOrder: 0,
    };
    // The list showed "Set" or "None" for an image that no form could ever set: the
    // column existed in the schema and the server accepted it, but nothing sent it.
    // That is the third place an image had no way in, and the reason a category
    // image could only ever arrive by writing SQL by hand.
    let mediaR2Key = category.mediaR2Key || "";
    const body = el("div");
    const modal = openModal({
      title: isNew ? "Add category" : `Edit ${category.name}`,
      width: "narrow",
      render: () => body,
    });

    const imageRow = el("div", { class: "field" });
    function paintImageRow() {
      mount(imageRow,
        el("span", { class: "field-label", text: "Category image" }),
        el("div", { class: "uploader-row" },
          mediaR2Key
            ? el("div", { class: "image-preview" },
              el("img", { class: "picker-thumb", src: `${imageBase()}/${mediaR2Key}`, alt: "", loading: "lazy" }))
            : el("span", { class: "muted", text: "No image chosen" }),
          adminImageUploader({
            onUploaded: (media) => { mediaR2Key = media.r2Key; paintImageRow(); },
          }),
          adminImagePicker({
            title: "Choose the category image",
            max: 1,
            onSelect: ([media]) => { if (media) { mediaR2Key = media.r2Key; paintImageRow(); } },
          }),
          mediaR2Key
            ? el("button", { class: "button button-small", type: "button", text: "Remove", onclick: () => { mediaR2Key = ""; paintImageRow(); } })
            : null),
        el("p", { class: "field-error", dataset: { errorFor: "mediaR2Key" } }));
    }
    paintImageRow();

    const form = el("form", { class: "form", onsubmit: (e) => e.preventDefault() },
      fieldset({ legend: "Category", fields: [
        adminField({ name: "name", label: "Name", value: category.name, hint: "Shown to customers." }),
        adminField({ name: "slug", label: "URL slug", value: category.slug, hint: "Lowercase letters, numbers and single dashes." }),
        adminField({ name: "description", label: "Description", value: category.description || "", type: "textarea" }),
      ] }),
      // Its own fieldset rather than a row in "Placement": an image is content, not
      // a setting, and putting it with sort order is how it ended up unreachable.
      fieldset({ legend: "Image", fields: [imageRow] }),
      fieldset({ legend: "Placement and state", columns: 2, fields: [
        adminField({
          name: "parentId", label: "Parent", type: "select", value: category.parentId ?? "",
          // A category cannot be its own parent, and the server refuses a cycle, so
          // the picker simply never offers the row being edited.
          options: [{ value: "", label: "— none (top level) —" },
            ...parents.filter((p) => p.id !== category.id).map((p) => ({ value: p.id, label: p.label }))],
        }),
        adminField({ name: "sortOrder", label: "Sort order", type: "number", value: category.sortOrder ?? 0, min: 0, step: 1 }),
        adminField({ name: "isActive", label: "Active", type: "checkbox", value: category.isActive !== false }),
      ] }),
      saveBar({
        saveLabel: isNew ? "Create category" : "Save changes",
        onCancel: () => modal.close(),
        onSave: async () => {
          const values = readForm(form);
          const payload = {
            name: values.name,
            slug: values.slug,
            description: values.description || null,
            parentId: values.parentId ? Number(values.parentId) : null,
            isActive: values.isActive,
            sortOrder: Number(values.sortOrder) || 0,
            // Sent on every save, including "" to clear it. The form's own state is
            // the source of truth, so a picture removed here is not resurrected by a
            // later edit of an unrelated field.
            mediaR2Key,
          };
          try {
            if (isNew) {
              await api.post("/categories", payload);
              toast(`Category “${payload.name}” created`, "success");
            } else {
              await api.patch(`/categories/${category.id}`, {
                ...payload, expectedUpdatedAt: toWireTimestamp(category.updatedAt),
              });
              toast("Category updated", "success");
            }
            modal.close();
            load();
          } catch (err) {
            if (err instanceof ApiError && err.isValidation && err.fields) {
              applyFieldErrors(form, err.fields);
              return;
            }
            // A duplicate slug or name is a 409 and the fix is to change a field,
            // not to reload the page.
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

  async function remove(row) {
    const ok = await confirmDialog({
      title: `Delete “${row.name}”?`,
      danger: true,
      requireText: "DELETE",
      confirmLabel: "Delete category",
      body: el("div", {},
        el("p", { text: "This cannot be undone." }),
        el("p", { class: "muted", text: "If any product still uses this category the server refuses and names those products. Sub-categories are refused too — deleting a parent would silently move them to the top level." })),
    });
    if (!ok) return;

    try {
      await api.del(`/categories/${row.id}`);
      toast(`Category “${row.name}” deleted`, "success");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.isConflict) {
        // The refusal IS the answer. Showing it in a dialog keeps the operator on
        // the list and makes the reason the most visible thing on screen.
        const affected = Array.isArray(err.current?.products) ? err.current.products : [];
        await confirmDialog({
          title: "Cannot delete this category",
          confirmLabel: "Understood",
          body: affected.length
            ? el("div", {},
              el("p", { text: err.message }),
              el("ul", { class: "dialog-list" }, affected.map((p) => el("li", { text: p.name }))))
            : el("p", { text: err.message }),
        });
        return;
      }
      toastError(err);
    }
  }

  return {
    start() {
      host = el("div", { class: "list" });
      mount(shell.content,
        el("div", { class: "list-panel" },
          el("div", { class: "list-head" },
            el("h2", { class: "list-title", text: "All categories" }),
            can("categories:write")
              ? el("button", { class: "button button-primary", type: "button", text: "+ Add category", onclick: () => openForm(null) })
              : null),
          host));

      // The controls are built ONCE here and never again. They used to be rebuilt
      // by every render(), which is what closed the search box on each keystroke.
      ui = listScaffold(host);
      mount(ui.controls,
        adminSearch({
          value: state.q, placeholder: "Search name or slug",
          onSearch: (value) => { state.q = value; state.page = 1; load(); },
        }),
        adminFilters({
          value: { filter: state.filter },
          filters: [{ key: "filter", label: "Show", options: [
            { value: "all", label: "All" },
            { value: "roots", label: "Top level only" },
            { value: "active", label: "Active only" },
            { value: "unused", label: "No products" },
          ] }],
          onChange: (next) => { state.filter = next.filter || "all"; state.page = 1; load(); },
        }));
      load();
    },
  };
}
