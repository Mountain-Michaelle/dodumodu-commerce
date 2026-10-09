import { el, mount, formatBytes, formatDateTime } from "../dom.js";
import { api, ApiError, qs } from "../api.js";
import {
  adminTable, adminSearch, adminFilters, adminPagination, resultCount, statusBadge,
  actionButtons, toast, toastError, confirmDialog, errorState, adminImageUploader,
  listScaffold,
} from "../ui.js";

// The media library: everything that has ever been uploaded, and whether anything
// still points at it.

/**
 * "Product image on #42" -> a short label an operator can act on.
 *
 * Built from the server's `usedBy`, so it names the same attachment the delete
 * refusal would list. `text` throughout, never innerHTML: ownerId and source come
 * from the database, and an operator must not be able to inject markup by naming a
 * file.
 */
function referenceLabel(ref) {
  const source = typeof ref?.source === "string" ? ref.source : "unknown";
  const id = Number.isFinite(ref?.ownerId) ? ` #${ref.ownerId}` : "";
  return `${source}${id}`;
}
//
// The interesting rule is that an image in use cannot be deleted. Deleting an
// object a live product page still references leaves a broken image on a page
// customers are looking at, and the reference lives in several tables - so the
// server asks all of them, live, and returns what it found. This screen shows
// that list rather than keeping its own tally, which would go stale the moment
// somebody edited a product.

const IMAGE_BASE = (typeof window !== "undefined" && window.IMAGE_DELIVERY_BASE) || "/media";

export function mediaView({ shell, identity }) {
  const state = { page: 1, pageSize: 50, q: "", filter: "all" };
  let host;
  let ui;

  const can = (permission) => (identity?.permissions || []).includes(permission);

  async function load() {
    try {
      const data = await ui.load((signal) => api.get(`/media${qs({
        q: state.q, filter: state.filter, page: state.page, pageSize: state.pageSize,
      })}`, signal), { pending: "Loading media…" });
      if (!data) return;
      render(data);
    } catch (err) {
      ui.results(errorState(err, load));
    }
  }

  function render({ media, page }) {
    ui.results(
      el("div", { class: "list-summary" }, resultCount({ page, noun: "image" })),
      adminTable({
        caption: "Media",
        rows: media,
        rowKey: (row) => row.id,
        columns: [
          { label: "Preview", className: "col-thumb", render: ({ row }) => el("img", {
            class: "thumb", src: `${IMAGE_BASE}/${row.r2Key}`, alt: "", loading: "lazy", width: 48, height: 48,
          }) },
          { label: "Storage key", render: ({ row }) => el("code", { class: "reference", text: row.r2Key }) },
          { label: "Type", render: ({ row }) => el("span", { class: "muted", text: row.contentType || "—" }) },
          { label: "Size", className: "col-num", render: ({ row }) => formatBytes(row.byteSize) },
          { label: "Dimensions", className: "col-num", render: ({ row }) => (row.width && row.height ? `${row.width}×${row.height}` : "—") },
          { label: "In use", render: ({ row }) => statusBadge(row.inUse ? "active" : "unused", row.inUse ? "In use" : "Unused") },
          // WHO uses it. "In use" alone makes an operator open every product to
          // find out; this names the attachment the server already resolved, and
          // it is the same data the delete refusal cites, so the two agree.
          {
            label: "Used by",
            render: ({ row }) => {
              const used = Array.isArray(row.usedBy) ? row.usedBy : [];
              if (used.length === 0) return el("span", { class: "muted", text: "—" });
              const shown = used.slice(0, 3).map((ref) => el("span", { class: "chip", text: referenceLabel(ref) }));
              if (used.length > 3) {
                shown.push(el("span", { class: "chip muted", text: `+${used.length - 3} more` }));
              }
              return el("div", { class: "chips" }, shown);
            },
          },
          { label: "Uploaded", className: "col-when", render: ({ row }) => el("span", { class: "nowrap", text: formatDateTime(row.createdAt) }) },
          { label: "Actions", className: "col-actions", render: ({ row }) => actionButtons(
            can("media:write")
              ? [{ label: "Delete", danger: true, onSelect: () => remove(row) }]
              : [],
          ) },
        ],
      }),
      adminPagination({
        page,
        onPage: (n) => { state.page = n; load(); },
        onPageSize: (n) => { state.pageSize = n; state.page = 1; load(); },
      }));
  }

  /**
   * Deleting is refused while the key is referenced, and the refusal names where.
   * That answer comes from the server's live reference query, so it is the truth
   * rather than a flag some other screen was supposed to keep in step.
   */
  async function remove(row) {
    const ok = await confirmDialog({
      title: "Delete this image?",
      danger: true,
      requireText: "DELETE",
      confirmLabel: "Delete image",
      body: el("div", {},
        el("p", {}, "This removes the stored file and its registry row."),
        el("p", { class: "muted", text: "If a product, category or testimonial still points at it, the server refuses and lists what is using it." })),
    });
    if (!ok) return;

    try {
      await api.del(`/media/${row.id}`);
      toast("Image deleted", "success");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.isConflict) {
        const references = Array.isArray(err.current?.references) ? err.current.references : [];
        await confirmDialog({
          title: "This image is still in use",
          confirmLabel: "Understood",
          body: references.length
            ? el("div", {},
              el("p", { text: err.message }),
              el("ul", { class: "dialog-list" }, references.map((ref) => el("li", { text: ref.source }))))
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
            el("h2", { class: "list-title", text: "Uploaded images" }),
            can("media:write") ? adminImageUploader({
              onUploaded: () => { toast("Image uploaded", "success"); load(); },
            }) : null),
          host));
      // Built once. Rebuilding these on every render() is what closed the search
      // box after each pause.
      ui = listScaffold(host);
      mount(ui.controls,
        adminSearch({
          value: state.q, placeholder: "Search storage key",
          onSearch: (value) => { state.q = value; state.page = 1; load(); },
        }),
        adminFilters({
          value: { filter: state.filter },
          filters: [{ key: "filter", label: "Show", options: [
            { value: "all", label: "All" },
            { value: "unattached", label: "Never attached" },
            { value: "unused", label: "Not referenced" },
          ] }],
          onChange: (next) => { state.filter = next.filter || "all"; state.page = 1; load(); },
        }));
      load();
    },
  };
}
