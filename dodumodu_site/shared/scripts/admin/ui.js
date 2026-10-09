import { el, mount, copyToClipboard, formatBytes } from "./dom.js";
import { api, ApiError, qs } from "./api.js";

// The reusable admin pieces. They are primitives rather than a framework: each one
// is a function that returns DOM, none of them knows what an order is, and none
// of them decides a business rule. That is the line - a table here draws whatever
// columns it is handed, and a view decides which columns those are.
//
// The list follows the specification's own vocabulary (AdminTable, AdminPagination,
// AdminSearch, AdminFilters, AdminForm, AdminField, AdminActionMenu,
// AdminConfirmDialog, AdminImageUploader, AdminStatusBadge, AdminToast) plus the
// few the real screens turn out to need: a modal for detail and edit views, a
// result count, and a bulk-action bar.

/* ------------------------------------------------------------------ toasts */

let toastHost = null;

function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = el("div", { class: "toast-host", role: "status", "aria-live": "polite" });
  document.body.append(toastHost);
  return toastHost;
}

export function toast(message, kind = "info", ms = 4000) {
  const node = el("div", { class: `toast toast-${kind}`, text: message });
  ensureToastHost().append(node);
  // A toast that stays forever is a wall of text; one that vanishes too fast is
  // unreadable. A long message gets more time on screen, not a fixed timer.
  const life = Math.min(ms + message.length * 20, 12000);
  setTimeout(() => {
    node.classList.add("toast-leaving");
    setTimeout(() => node.remove(), 200);
  }, life);
  return node;
}

export const toastError = (err) =>
  toast(err instanceof ApiError ? err.message : String(err?.message || err), "error", 7000);

/* ------------------------------------------------------- confirm dialog */

/**
 * A real confirmation, because the destructive actions here (delete an order, a
 * category, a stored image) remove data that cannot be recovered. `requireText` is
 * the stronger form used for order deletion: the operator types the word, which is
 * what stops a mis-click from deleting a sale.
 */
export function confirmDialog({ title, body, confirmLabel = "Confirm", danger = false, requireText = null }) {
  return new Promise((resolve) => {
    const done = (value) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(value); };
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
      if (e.key === "Enter" && allowed()) done(true);
    };
    const allowed = () => (requireText
      ? input.value.trim().toUpperCase() === requireText.toUpperCase()
      : true);

    const input = requireText
      ? el("input", { class: "input", type: "text", placeholder: requireText, autocomplete: "off" })
      : null;

    const confirmButton = el("button", {
      class: danger ? "button button-danger" : "button button-primary",
      type: "button", text: confirmLabel, disabled: Boolean(requireText),
      onclick: () => done(true),
    });

    if (input) {
      input.addEventListener("input", () => { confirmButton.disabled = !allowed(); });
    }

    const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) done(false); } },
      el("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        el("h2", { class: "dialog-title", text: title }),
        el("div", { class: "dialog-body" }, typeof body === "string" ? el("p", { text: body }) : body),
        input ? el("label", { class: "dialog-confirm" }, input,
          el("span", { class: "hint", text: `Type ${requireText} to confirm` })) : null,
        el("div", { class: "dialog-actions" },
          el("button", { class: "button", type: "button", text: "Cancel", onclick: () => done(false) }),
          confirmButton)));

    document.body.append(overlay);
    document.addEventListener("keydown", onKey);
    (input || confirmButton).focus();
  });
}

/**
 * A confirmation that records WHY, for decisions that must be auditable
 * (cancelling an order). Same shape as confirmDialog, with three differences
 * that come from what typing in a dialog is like on a real keyboard:
 *
 *   - Enter never submits. Inside the textarea it inserts a newline; the dialog
 *     only ever closes from a button, so a half-typed reason can't be sent or
 *     lost to an accidental keypress.
 *   - Escape and outside-clicks only close the dialog while the reason box is
 *     EMPTY. Once text exists, discarding it needs an explicit click on Close.
 *   - The confirm button stays disabled until the reason meets `minLength` and
 *     for the whole in-flight request, so a double-click can't fire twice. If
 *     the request fails the dialog STAYS OPEN with the text intact; only a
 *     version conflict (the row moved under the operator) closes it, because
 *     the correct next step there is a reload, not another try.
 *
 * Resolves `{ ok: true }` after a successful submit, `{ ok: false }` on an
 * ordinary dismissal, or `{ ok: false, conflict: true }` when the server
 * reported the record changed concurrently.
 */
export function reasonDialog({
  title, body, confirmLabel = "Confirm", danger = false,
  placeholder = "", minLength = 12, submit,
}) {
  return new Promise((resolve) => {
    let textarea, error, confirmButton, closeButton;
    let inFlight = false;
    const done = (value) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(value); };
    const text = () => (textarea.value || "").trim().replace(/\s+/g, " ");
    const valid = () => text().length >= minLength;
    const validate = () => {
      const problem = valid() ? null : `At least ${minLength} characters, so this can be reviewed later.`;
      error.textContent = problem || "";
      confirmButton.disabled = inFlight || !valid();
      return valid();
    };
    const onKey = (event) => {
      if (event.key === "Escape" && !inFlight && text() === "") done({ ok: false });
      // Enter is deliberately not handled: in a textarea it must insert a line.
    };

    textarea = el("textarea", { class: "input", rows: "4", placeholder, oninput: validate });
    error = el("p", { class: "field-error" });
    closeButton = el("button", {
      class: "button", type: "button", text: "Close",
      onclick: () => { if (!inFlight) done({ ok: false }); },
    });
    confirmButton = el("button", {
      class: danger ? "button button-danger" : "button button-primary",
      type: "button", text: confirmLabel, disabled: true,
      onclick: async () => {
        if (inFlight || !validate()) return;
        inFlight = true;
        confirmButton.disabled = true;
        confirmButton.textContent = "Working…";
        closeButton.disabled = true;
        try {
          await submit(text());
          done({ ok: true });
        } catch (err) {
          inFlight = false;
          confirmButton.textContent = confirmLabel;
          closeButton.disabled = false;
          if (err instanceof ApiError && err.isConflict) {
            done({ ok: false, conflict: true });
            return;
          }
          error.textContent = err instanceof ApiError ? err.message : String(err?.message || err);
          validate();
        }
      },
    });

    const overlay = el("div", {
      class: "overlay",
      // With typed text, a stray backdrop click does nothing - the text survives.
      onclick: (e) => { if (e.target === overlay && text() === "" && !inFlight) done({ ok: false }); },
    },
      el("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        el("h2", { class: "dialog-title", text: title }),
        el("div", { class: "dialog-body" },
          typeof body === "string" ? el("p", { text: body }) : body,
          el("label", { class: "stack" },
            el("span", { class: "muted", text: "Reason (required)" }), textarea),
          error),
        el("div", { class: "dialog-actions" }, closeButton, confirmButton)));

    document.body.append(overlay);
    document.addEventListener("keydown", onKey);
    textarea.focus();
  });
}

/* ----------------------------------------------------------------- modal */

/**
 * The detail/edit overlay. `render` receives a close() so a view can build whatever
 * it needs and wire its own save bar, rather than the modal having to know what a
 * "form" is.
 */
export function openModal({ title, render, width = "wide" }) {
  const body = el("div", { class: "modal-body" });
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };

  const overlay = el("div", { class: "overlay" },
    el("div", { class: `modal modal-${width}`, role: "dialog", "aria-modal": "true" },
      el("div", { class: "modal-head" },
        el("h2", { class: "modal-title", text: title }),
        el("button", { class: "icon-button", type: "button", title: "Close", "aria-label": "Close", text: "×", onclick: close })),
      body));

  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  mount(body, render(close));
  return { close, body };
}

/* --------------------------------------------------------- status badge */

/**
 * A status as a small coloured flag, Django-style. The tone comes from a fixed map
 * rather than from the status string, so an unrecognised value renders as a neutral
 * badge instead of a class name built out of whatever a server happened to send.
 */
const STATUS_TONE = {
  paid: "ok", delivered: "ok", active: "ok", root: "info",
  confirmed_cod: "info", unprocessed: "info",
  awaiting_payment: "warn", unused: "warn", unattached: "warn", low: "warn",
  failed: "bad", high: "bad",
};

export function statusBadge(status, label) {
  const value = String(status ?? "").trim();
  return el("span", {
    class: `badge badge-${STATUS_TONE[value] || "neutral"}`,
    text: label || value.replace(/_/g, " ") || "-",
  });
}

/* --------------------------------------------------------- action menu */

/**
 * The per-row action menu. `actions` comes from the SERVER, not from a table in
 * this file: what an operator may do to an order is decided by orderCrmService,
 * and a browser copy of those rules is a second opinion that will drift. If the
 * server offers three actions, three appear - and an illegal one cannot be
 * conjured by editing this file, because there is nothing here to edit.
 */
export function actionMenu(actions) {
  const visible = (actions || []).filter((action) => !action.hidden);
  if (visible.length === 0) return el("span", { class: "muted", text: "—" });

  const list = el("div", { class: "action-menu-list", role: "menu" },
    visible.map((action) => el("button", {
      class: `action-menu-item${action.danger ? " is-danger" : ""}`,
      type: "button", role: "menuitem", text: action.label,
      onclick: (event) => { event.stopPropagation(); close(); action.onSelect(); },
    })));

  const trigger = el("button", {
    class: "action-menu-trigger", type: "button", "aria-haspopup": "menu", "aria-expanded": "false",
    onclick: (event) => { event.stopPropagation(); toggle(); },
  }, el("span", { text: "Actions" }), el("span", { class: "caret", text: "▾" }));

  const menu = el("div", { class: "action-menu" }, trigger, list);
  let open = false;
  function toggle() {
    open = !open;
    menu.classList.toggle("is-open", open);
    trigger.setAttribute("aria-expanded", String(open));
  }
  const close = () => { if (open) toggle(); };

  // Click-away and Escape, because a menu that traps the pointer is a bug report.
  document.addEventListener("click", (event) => { if (open && !menu.contains(event.target)) close(); });
  document.addEventListener("keydown", (event) => { if (open && event.key === "Escape") close(); });

  return menu;
}

/** A plain button row, for screens with too few actions to need a menu. */
export function actionButtons(actions) {
  const visible = (actions || []).filter((action) => !action.hidden);
  if (visible.length === 0) return el("span", { class: "muted", text: "—" });
  return el("div", { class: "action-buttons" },
    visible.map((action) => el("button", {
      class: `button button-small${action.danger ? " button-danger" : ""}${action.primary ? " button-primary" : ""}`,
      type: "button", text: action.label, onclick: action.onSelect,
    })));
}

export { copyToClipboard };

/* ------------------------------------------------------------------ table */

/**
 * The result table. `columns` is a list of { key, label, render?, className? } and
 * `rows` the data - the table knows nothing about what it is drawing, which is what
 * lets one component serve orders, categories, products and media.
 *
 * `empty` is a real state rather than an empty tbody, because "no rows" and "the
 * request failed" otherwise look identical and the operator cannot tell which
 * happened.
 */
export function adminTable({ columns, rows, rowKey, onRowClick, empty, loading, caption, rowClass }) {
  if (loading) {
    return el("div", { class: "table-state" },
      el("div", { class: "spinner", "aria-hidden": "true" }),
      el("p", { class: "muted", text: "Loading…" }));
  }
  if (empty) {
    return el("div", { class: "table-state" },
      el("p", { class: "table-state-title", text: empty.title || "Nothing here yet" }),
      el("p", { class: "muted", text: empty.body || "" }),
      empty.action || null);
  }
  if (!rows || rows.length === 0) {
    return el("div", { class: "table-state" },
      el("p", { class: "table-state-title", text: "No matching records" }),
      el("p", { class: "muted", text: "Try a different search or filter." }));
  }

  const head = el("tr", {}, columns.map((column) => el("th", {
    class: column.className || "", scope: "col", text: column.label,
  })));

  const body = el("tbody", {}, rows.map((row, index) => {
    const tr = el("tr", {
      // `rowClass` is an optional per-row class hook, used today by the spam tint.
      // It is additive and defaults to nothing, so every existing caller renders
      // exactly as before.
      class: [onRowClick ? "is-clickable" : "", rowClass ? rowClass(row) : ""].filter(Boolean).join(" "),
      dataset: { key: rowKey ? String(rowKey(row)) : String(index) },
      onclick: onRowClick ? (event) => {
        // A click landing on a button, link or menu belongs to that control, not to
        // the row - otherwise every action in a row becomes impossible to press.
        if (event.target.closest("button, a, .action-menu, input, select, label")) return;
        onRowClick(row);
      } : undefined,
    }, columns.map((column) => {
      const value = column.render ? column.render({ row }) : row[column.key];
      return el("td", { class: column.className || "" },
        value === null || value === undefined || value === "" ? el("span", { class: "muted", text: "—" }) : value);
    }));
    return tr;
  }));

  return el("div", { class: "table-wrap" },
    el("table", { class: "table" },
      caption ? el("caption", { class: "sr-only", text: caption }) : null,
      el("thead", {}, head), body));
}

/* -------------------------------------------------------- result count */

/** "8 orders" / "8 orders (page 1 of 3)" - Django's phrasing, because it is clear. */
export function resultCount({ page, noun = "record", plural }) {
  if (!page) return el("span", { class: "muted" });
  const word = page.total === 1 ? noun : (plural || `${noun}s`);
  const total = page.total === 0 ? `0 ${word}` : `${page.total.toLocaleString()} ${word}`;
  const paging = page.totalPages > 1 ? ` (page ${page.page} of ${page.totalPages})` : "";
  return el("span", { class: "result-count", text: total + paging });
}

/* ------------------------------------------------------------- search */

/**
 * The search box.
 *
 * The term is server-side and debounced: this is a text search across columns
 * holding customer names and phone numbers, so it belongs in SQL where it can use
 * an index, and it costs one request per pause rather than one per keystroke.
 *
 * What this does NOT do is rebuild itself. Search-as-you-type only works if the
 * element the operator is typing into is the same element across the whole
 * session - see listScaffold for why that is the view's job and not this one's.
 *
 * `minLength` is the floor below which no request is made. Two characters is not
 * arbitrary: below it the result set is most of the table, so the round trip buys
 * a slower list and a scarier-looking spinner in exchange for nothing. Clearing the
 * box always searches - an empty term is a real query, not "too short".
 */
export function adminSearch({ value = "", placeholder = "Search", onSearch, minLength = 2, delay = 300 }) {
  const input = el("input", {
    class: "input search-input", type: "search", value,
    placeholder, autocomplete: "off", "aria-label": placeholder,
  });
  const status = el("span", { class: "search-status", role: "status", "aria-live": "polite" });

  let timer = null;
  // The last term actually sent. Without this, a re-render with an unchanged term
  // fires another identical request, and a slow second response can arrive to
  // overwrite a correct first one.
  let lastSent = value;

  const tooShort = (term) => term.length > 0 && term.length < minLength;

  function run() {
    const term = input.value.trim();
    if (tooShort(term)) {
      status.textContent = `Type ${minLength} characters to search`;
      return;
    }
    status.textContent = "";
    if (term === lastSent) return;
    lastSent = term;
    onSearch(term);
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const term = input.value.trim();
    // Say something under the floor. Silence here reads as "searching" forever,
    // which is a worse answer than "type one more character".
    status.textContent = tooShort(term) ? `Type ${minLength} characters to search` : "";
    if (tooShort(term)) return;
    timer = setTimeout(run, delay);
  });

  // Enter runs it immediately rather than waiting out the pause, and Escape clears
  // back to the unfiltered list - the two things a search box is expected to do.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { clearTimeout(timer); run(); }
    if (event.key === "Escape") {
      clearTimeout(timer);
      input.value = "";
      status.textContent = "";
      if (lastSent !== "") { lastSent = ""; onSearch(""); }
    }
  });

  return el("div", { class: "search" },
    el("span", { class: "search-icon", "aria-hidden": "true", text: "⌕" }), input, status);
}

/* ----------------------------------------------------------- scaffold */

/**
 * A list screen in two halves: the CONTROLS, built once and then never touched
 * again, and the RESULTS, replaced on every load.
 *
 * This exists because of a bug that is invisible in code review and unbearable in
 * use. The views used to build the whole screen - search box, filters, table,
 * pagination - inside one render() call. Typing a character therefore did this:
 *
 *   1. the debounce fired, calling load()
 *   2. load() replaced the entire host with a "Loading…" spinner
 *   3. the response arrived, and render() built the screen again
 *   4. a BRAND NEW <input> replaced the one being typed into
 *
 * Focus died at step 2 and again at step 4, so the caret vanished and the operator
 * had to click back into the box before the next character could be typed. The
 * search looked live - it genuinely did fire per pause - and it was unusable,
 * because a box that closes itself after every pause is not a box you can type
 * more than two characters into.
 *
 * The fix is structural rather than clever: the controls are created once and never
 * re-parented, so the element being typed into is the same element for the whole
 * session. Only the results half is volatile. Focus, caret and any half-typed word
 * survive every request by construction, because a request cannot touch them.
 */
export function listScaffold(host) {
  const controls = el("div", { class: "list-controls" });
  const results = el("div", { class: "list-results" });
  mount(host, controls, results);

  // One in-flight request at a time. A superseded search must not be able to
  // render over the results of the search that replaced it.
  let inflight = null;

  const clearPending = () => {
    results.removeAttribute("aria-busy");
    results.classList.remove("is-loading");
    for (const node of [...results.querySelectorAll(".list-pending")]) node.remove();
  };

  return {
    /** The persistent half. Fill this once, at view setup. */
    controls,

    /**
     * The results NODE, for a caller that needs to lay it out itself.
     *
     * Distinct from `results(...)`, which fills it. The two names being confusable is
     * how `mount(body, ui.results)` once passed the function where a node belonged and
     * rendered "undefined" into the page.
     */
    resultsNode: results,

    /** Replaces the results half. Safe to call while the operator is typing. */
    results(...children) {
      mount(results, ...children);
    },

    /**
     * Loads through `fetcher`, cancelling whatever was already in flight.
     *
     * `fetcher` receives an AbortSignal, handed to api.get so the browser actually
     * tears the request down rather than merely ignoring its answer - which matters
     * on a phone, where an abandoned search still competes for the radio.
     *
     * The pending state is deliberately NOT a full-screen replacement: it flags the
     * results half and appends one line of text, so the previous rows stay put and
     * dimmed while the next arrives. Blanking the page is what made the old version
     * feel like it was reloading, and it destroyed the scroll position.
     */
    async load(fetcher, { pending = "Loading…" } = {}) {
      if (inflight) inflight.abort();
      const controller = new AbortController();
      inflight = controller;
      results.setAttribute("aria-busy", "true");
      results.classList.add("is-loading");
      if (pending) {
        results.append(el("div", { class: "list-pending", role: "status", text: pending }));
      }
      try {
        const data = await fetcher(controller.signal);
        // A response that lost its race must not render, even if it did arrive.
        if (controller.signal.aborted) return null;
        inflight = null;
        clearPending();
        return data;
      } catch (err) {
        if (controller.signal.aborted || err?.name === "AbortError") return null;
        inflight = null;
        clearPending();
        throw err;
      }
    },

    /** Cancels anything in flight, for when a view is torn down mid-search. */
    abort() {
      if (inflight) inflight.abort();
      inflight = null;
      clearPending();
    },
  };
}

/* ------------------------------------------------------------ filters */

/**
 * A row of selects, each writing one key of the query object. Declared as data so
 * a screen defines its filter bar in one line and every screen gets the same
 * markup, the same "All" default and the same reset behaviour.
 *
 * `value` carries only APPLIED filters: `""` or an omitted key means "no filter",
 * because the primitive's own first option IS the reset state. A view-level no-op
 * value ("all") counts as active here - it shows "Clear filters" on a list nothing
 * is filtered, and clicking it re-sends the same query: the button vanishes while
 * nothing on screen changes, which reads as a broken control.
 *
 * The controls are built ONCE per screen (that is what keeps the search box's
 * focus alive), so `value` is a build-time snapshot: anything closed over here
 * is frozen at build time. `current` is the live copy of what the operator has
 * picked. Without it, a second change spread the ORIGINAL value and silently
 * reset every other key to its initial value - while the other selects still
 * displayed the operator's choices. The list quietly stopped honouring a filter
 * the bar still claimed was on, which is exactly how a filter reads as "not
 * functional". Single-filter screens (Categories, Media) never showed it;
 * Orders (three filters) and Products (two) lost one filter per extra pick.
 */
export function adminFilters({ filters, value = {}, onChange }) {
  const current = { ...value };
  const selects = new Map();

  const active = () => Object.values(current).some((v) => v !== undefined && v !== "" && v !== null);

  // Present in the DOM from the start and only hidden. Rendering it only when a
  // filter was active AT BUILD TIME - the old behaviour - meant it could never
  // appear at all: the controls are built before the operator has picked anything.
  const clear = el("button", {
    class: "button button-link", type: "button", text: "Clear filters", hidden: !active(),
    onclick: () => {
      for (const key of Object.keys(current)) delete current[key];
      // The selects hold their own displayed value, so clearing the state
      // without resetting them leaves a bar showing filters the list is no
      // longer applying.
      for (const select of selects.values()) select.value = "";
      clear.hidden = true;
      onChange({});
    },
  });

  const controls = filters.map((filter) => {
    const select = el("select", {
      class: "select", "aria-label": filter.label,
      onchange: (event) => {
        const picked = event.target.value || undefined;
        if (picked === undefined) delete current[filter.key];
        else current[filter.key] = picked;
        clear.hidden = !active();
        onChange({ ...current });
      },
    }, [
      el("option", { value: "", text: filter.allLabel || "All" }),
      ...filter.options.map((option) => el("option", {
        value: String(option.value), text: option.label,
        selected: String(value[filter.key] ?? "") === String(option.value),
      })),
    ]);
    selects.set(filter.key, select);
    return el("label", { class: "filter" },
      el("span", { class: "filter-label", text: filter.label }), select);
  });

  return el("div", { class: "filters" }, controls, clear);
}

/* -------------------------------------------------------- image picker */

/** Where image bytes are served from. Same source the media screen uses. */
export function imageBase() {
  return (typeof window !== "undefined" && window.IMAGE_DELIVERY_BASE) || "/media";
}

/**
 * Choose an image that was already uploaded.
 *
 * Why this exists: uploading worked, but nothing could ever REUSE what was already
 * in the library. An operator with a good product shot had no way to point a second
 * product or a testimonial at it, so the library filled with near-duplicates while
 * the original sat there unreferenced forever - paid for in storage, visible to
 * nobody. The library was write-only.
 *
 * It reuses the pieces the codebase already has rather than inventing a second way
 * to do each thing: listScaffold, so the search box keeps focus as it does on a
 * list; adminPagination, so paging is the same control and not a bespoke one.
 *
 * Selection is click-to-toggle and `max` bounds it, so a caller asking for one
 * image cannot accidentally attach five.
 *
 * It returns a BUTTON, the same shape adminImageUploader returns a control rather
 * than opening something itself. A field then reads as a row of two ways in and one
 * of them is "use something I already have" - which is what it means in practice,
 * and it means the picker is never opened by a screen it was not asked about.
 */
export function adminImagePicker({
  label = "Reuse an uploaded image",
  title = "Choose an uploaded image",
  max = 1,
  onSelect,
  onCancel,
} = {}) {
  return el("button", {
    class: "button", type: "button", text: label,
    onclick: () => openPicker({ title, max, onSelect, onCancel }),
  });
}

function openPicker({ title = "Choose an uploaded image", max = 1, onSelect, onCancel } = {}) {
  const state = { page: 1, pageSize: 24, q: "", filter: "" };
  // A Map keyed by id: choosing the same image twice is impossible, and the order
  // chosen is the order attached.
  const chosen = new Map();

  const body = el("div", { class: "picker" });
  const modal = openModal({ title, render: () => body });
  const ui = listScaffold(body);
  const grid = el("div", { class: "picker-grid" });
  const footer = el("div", { class: "picker-foot" });

  const atMax = () => chosen.size >= max;
  let lastRows = [];

  function paintFooter() {
    mount(footer,
      el("span", { class: "picker-count muted", text: chosen.size === 0
        ? "Nothing selected"
        : `${chosen.size} of ${max} selected` }),
      el("div", { class: "picker-actions" },
        el("button", { class: "button", type: "button", text: "Cancel", onclick: () => { ui.abort(); modal.close(); onCancel?.(); } }),
        el("button", {
          class: "button button-primary", type: "button",
          text: chosen.size ? `Use ${chosen.size === 1 ? "image" : `${chosen.size} images`}` : "Use image",
          disabled: chosen.size === 0,
          onclick: () => { ui.abort(); modal.close(); onSelect?.([...chosen.values()]); },
        })));
  }

  function tile(row) {
    const isChosen = chosen.has(row.id);
    const blocked = !isChosen && atMax();
    return el("button", {
      class: `picker-tile${isChosen ? " is-chosen" : ""}`,
      type: "button",
      // aria-pressed reports a toggle's state; aria-selected on a plain button does
      // not, so a screen reader would announce every tile identically.
      "aria-pressed": isChosen ? "true" : "false",
      "aria-label": isChosen ? `Deselect ${row.r2Key}` : `Select ${row.r2Key}`,
      disabled: blocked,
      title: row.r2Key,
      onclick: () => {
        if (chosen.has(row.id)) chosen.delete(row.id);
        // Tapping another tile while at the limit REPLACES rather than refuses:
        // with max = 1 that is what "choose a different one" means.
        else if (max === 1) { chosen.clear(); chosen.set(row.id, row); }
        else if (!atMax()) chosen.set(row.id, row);
        paintFooter();
        // Only the tiles change, so this repaints the grid rather than reloading:
        // choosing an image must not cost a request or lose the search box.
        paintGrid();
      },
    },
      // Lazy and display-sized: a grid of full-resolution photographs is the
      // heaviest thing on this screen. The uploader exists precisely so these are
      // already modest, and the browser fetches each only as it nears the viewport.
      el("img", {
        class: "picker-thumb", src: `${imageBase()}/${row.r2Key}`, alt: "", loading: "lazy", decoding: "async",
      }),
      el("span", { class: "picker-tick", "aria-hidden": "true", text: isChosen ? "✓" : "" }));
  }

  function paintGrid() {
    mount(grid, lastRows.length === 0
      ? el("p", { class: "muted picker-empty", text: "No images here. Try another filter, or upload one below." })
      : el("div", { class: "picker-grid-inner" }, lastRows.map(tile)));
  }

  async function load() {
    try {
      const data = await ui.load((signal) => api.get(`/media${qs({
        q: state.q, filter: state.filter, page: state.page, pageSize: state.pageSize,
      })}`, signal), { pending: "Loading images…" });
      if (!data) return;
      lastRows = data.media || [];
      paintGrid();
      // The same paginator the lists use, on the same server page metadata, so
      // "next" is never a dead button on a short last page.
      ui.results(grid, adminPagination({
        page: data.page,
        pageSizeOptions: [24, 48, 96],
        onPage: (n) => { state.page = n; load(); },
        onPageSize: (n) => { state.pageSize = n; state.page = 1; load(); },
      }));
    } catch (err) {
      ui.results(errorState(err, load));
    }
  }

  // Controls are built once, so this search box behaves like every other one.
  mount(ui.controls,
    adminSearch({
      placeholder: "Search uploaded images",
      onSearch: (value) => { state.q = value; state.page = 1; load(); },
    }),
    // "Not in use" is offered because the images that piled up unreferenced are
    // exactly the ones someone means when they ask "have I already got that?".
    adminFilters({
      value: { filter: state.filter },
      // "" (the primitive's own first option, labelled via allLabel) is the
      // no-filter state; a view-level "all" would read as an applied filter and
      // show Clear filters on a picker nothing is filtered.
      filters: [{ key: "filter", label: "Show", allLabel: "All images", options: [
        { value: "unused", label: "Not in use" },
        { value: "unattached", label: "Never attached" },
      ] }],
      onChange: (next) => { state.filter = next.filter || ""; state.page = 1; load(); },
    }));

  // `resultsNode` is the DOM node; `results(...)` is the method that fills it. Using
  // the wrong one here put `undefined` in the tree, so the node is named explicitly.
  mount(body, ui.controls, ui.resultsNode, footer);
  paintFooter();
  load();

  return modal;
}

/* --------------------------------------------------------- pagination */

/**
 * The paginator. `page` is the server's pageMeta, derived from the count the query
 * actually ran - so "next" is never a dead button on a short last page. Page
 * numbers are windowed, because a table with 400 page buttons is not a paginator.
 */
export function adminPagination({ page, pageSizeOptions = [50, 100, 1000], onPage, onPageSize, extra = null }) {
  if (!page) return null;

  const go = (n) => onPage(Math.max(1, Math.min(page.totalPages, n)));
  const numbers = [];
  for (let n = 1; n <= page.totalPages; n += 1) {
    if (n === 1 || n === page.totalPages || Math.abs(n - page.page) <= 2) {
      numbers.push(n);
    } else if (numbers[numbers.length - 1] !== "…") {
      numbers.push("…");
    }
  }

  return el("div", { class: "pagination" },
    extra,
    el("div", { class: "pager" },
      el("button", { class: "button button-small", type: "button", text: "‹ Prev", disabled: !page.hasPrev, onclick: () => go(page.page - 1) }),
      el("span", { class: "pager-numbers" }, numbers.map((n) => (n === "…"
        ? el("span", { class: "pager-gap", text: "…" })
        : el("button", {
          class: `button button-small${n === page.page ? " is-current" : ""}`,
          type: "button", text: String(n),
          "aria-current": n === page.page ? "page" : undefined,
          onclick: () => go(n),
        })))),
      el("button", { class: "button button-small", type: "button", text: "Next ›", disabled: !page.hasNext, onclick: () => go(page.page + 1) })),
    onPageSize ? el("label", { class: "page-size" },
      el("span", { class: "muted", text: "Per page" }),
      el("select", {
        class: "select select-small", "aria-label": "Rows per page",
        onchange: (event) => onPageSize(Number(event.target.value)),
      }, pageSizeOptions.map((size) => el("option", {
        value: String(size), text: String(size), selected: size === page.pageSize,
      })))) : null);
}

/* ------------------------------------------------------------ bulk bar */

/**
 * The bar that appears when rows are ticked. One button per action, and the
 * outcome is reported honestly afterwards: a bulk call answers {updated, skipped,
 * errors} and a panel that only said "done" would hide a partial run.
 */
export function bulkBar({ count, actions, onClear }) {
  return el("div", { class: "bulk-bar", role: "region", "aria-label": "Bulk actions" },
    el("span", { class: "bulk-count", text: `${count} selected` }),
    actions.map((action) => el("button", {
      class: `button button-small${action.danger ? " button-danger" : ""}`,
      type: "button", text: action.label, onclick: action.onSelect,
    })),
    el("button", { class: "button button-link", type: "button", text: "Clear", onclick: onClear }));
}

/* --------------------------------------------------------------- forms */

/**
 * One labelled field, with room for a hint and for the server's own note.
 *
 * The error slot is the important part: the API returns { fields: { name: [...] } }
 * keyed by field name, and putting each message beside the box it belongs to is the
 * difference between "fix this" and "find this".
 */
export function adminField({ name, label, value = "", type = "text", required, hint, placeholder, options, rows, readonly, autocomplete, min, step, onInput }) {
  let control;
  if (type === "textarea") {
    control = el("textarea", { class: "input textarea", name, rows: rows || 3, placeholder: placeholder || "" }, value ?? "");
  } else if (type === "select") {
    control = el("select", { class: "select", name },
      (options || []).map((option) => el("option", {
        value: String(option.value), text: option.label,
        selected: String(value ?? "") === String(option.value),
        disabled: option.disabled,
      })));
  } else if (type === "checkbox") {
    control = el("input", { class: "checkbox", type: "checkbox", name, checked: Boolean(value) });
  } else {
    control = el("input", {
      class: "input", type, name, value: value ?? "", placeholder: placeholder || "",
      min, step, autocomplete: autocomplete || "off", readonly,
    });
  }

  if (onInput) control.addEventListener("input", onInput);

  const error = el("p", { class: "field-error", dataset: { errorFor: name } });
  const wrap = el("label", { class: `field${type === "checkbox" ? " field-checkbox" : ""}` },
    type === "checkbox" ? null : el("span", { class: "field-label", text: label }),
    control,
    type === "checkbox" ? el("span", { class: "field-label", text: label }) : null,
    hint ? el("span", { class: "hint", text: hint }) : null,
    error);

  // Exposed so a form can push server notes back after a failed save.
  wrap.setFieldError = (messages) => {
    const list = Array.isArray(messages) ? messages : (messages ? [messages] : []);
    error.textContent = list.join(" ");
    wrap.classList.toggle("has-error", list.length > 0);
  };
  return wrap;
}

/** A titled group of fields, Django's fieldset. */
export function fieldset({ legend, fields, columns = 2 }) {
  return el("fieldset", { class: "fieldset" },
    el("legend", { class: "fieldset-legend", text: legend }),
    el("div", { class: `field-grid field-grid-${columns}` }, fields));
}

/**
 * The save bar. Sticky at the bottom of a form so the button is reachable without
 * scrolling a long page back down, and it disables itself while saving so a double
 * click cannot submit twice.
 */
export function saveBar({ onSave, onCancel, saveLabel = "Save" }) {
  const status = el("span", { class: "save-status", role: "status" });
  const save = el("button", { class: "button button-primary", type: "submit", text: saveLabel });
  save.addEventListener("click", (event) => {
    event.preventDefault();
    save.disabled = true;
    status.textContent = "Saving…";
    Promise.resolve(onSave()).finally(() => {
      save.disabled = false;
      status.textContent = "";
    });
  });

  return el("div", { class: "save-bar" },
    status,
    el("div", { class: "save-actions" },
      onCancel ? el("button", { class: "button", type: "button", text: "Cancel", onclick: onCancel }) : null,
      save));
}

/** Collects a form's values, turning checkboxes into booleans. */
export function readForm(form) {
  const values = {};
  for (const [name, value] of new FormData(form).entries()) values[name] = value;
  for (const box of form.querySelectorAll('input[type="checkbox"][name]')) {
    values[box.name] = box.checked;
  }
  return values;
}

/**
 * Paints the API's field notes onto a form. Every field is cleared first, so a
 * second failure on a different field does not leave the previous error visible.
 */
export function applyFieldErrors(form, fields) {
  for (const wrap of form.querySelectorAll("[data-error-for]")) {
    wrap.classList.remove("has-error");
    const slot = wrap.querySelector("[data-error-for]");
    if (slot) slot.textContent = "";
  }
  for (const [name, messages] of Object.entries(fields || {})) {
    const wrap = form.querySelector(`[data-error-for="${CSS.escape(name)}"]`)?.closest(".field");
    if (wrap?.setFieldError) wrap.setFieldError(messages);
  }
}

/* -------------------------------------------------------- image uploader */

/**
 * Client-side resize before upload.
 *
 * The V1 image path is resize-then-PUT with no image pipeline on the server, and
 * that is a deliberate choice rather than a shortcut: a photo straight off a phone
 * is 4-8 MB, and shipping that to object storage on every paste is a bill and a
 * wait for both the operator and whoever loads the page afterwards. Resizing here
 * means the bytes that land are already the bytes the storefront will use.
 *
 * The longest edge is bounded rather than the file size, because what matters is
 * display size: the storefront shows a product image at most 1200px wide, and
 * anything larger is paid for and never seen.
 */
/**
 * SHA-256 of the RESIZED bytes, as hex.
 *
 * Hashed after the resize, not before, so two different originals that resize to the
 * same 1400px JPEG are recognised as the duplicate they are - which is the case
 * worth catching, since the operator uploaded the same picture twice.
 *
 * Returns null when SubtleCrypto is unavailable (a non-secure context, or an older
 * browser) so the upload proceeds unhashed. Deduplication is a convenience; it must
 * never be the reason an image fails to upload.
 */
async function sha256Of(blob) {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

const MAX_EDGE = 1400;
const JPEG_QUALITY = 0.82;

/**
 * Whether an image has pixels that are actually transparent.
 *
 * Sampling a small render rather than trusting the source MIME type is deliberate.
 * "PNG" does not mean "has alpha" - a screenshot saved as PNG is fully opaque, and
 * routing all of them through the lossless path would inflate a 300KB product shot
 * into several megabytes. The question is about the PIXELS, so it is asked of them.
 *
 * A 64px render is enough: transparency is not something that appears in one
 * pixel of a thumbnail and hides everywhere else, and the sample has to be cheap
 * because this runs for every upload.
 */
async function hasRealAlpha(bitmap) {
  const SAMPLE = 64;
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.clearRect(0, 0, SAMPLE, SAMPLE);
  ctx.drawImage(bitmap, 0, 0, SAMPLE, SAMPLE);
  try {
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    for (let i = 3; i < data.length; i += 4) {
      // Anything under fully opaque counts. A logo with soft edges has plenty.
      if (data[i] < 250) return true;
    }
    return false;
  } catch {
    // A tainted canvas (a cross-origin image) cannot be read. Guessing "opaque"
    // would flatten a transparent logo, so the answer is deliberately refused and
    // the caller falls back to its previous behaviour.
    return null;
  }
}

/**
 * The output format for a resize.
 *
 * Opaque images keep the JPEG path EXACTLY as it was. That is a hard requirement,
 * not an accident: JPEG at 0.82 is what every existing upload already produced, so
 * changing it would alter bytes for images that need no help and invalidate
 * whatever visual tuning has been done against them.
 *
 * Only an image with real transparency takes the lossless path, and even then the
 * choice is PNG rather than WebP: the spec keeps PNG for genuine transparency and
 * flat graphics, and an image with alpha is by definition not a photograph.
 */
export function planImageOutput({ hasAlpha }) {
  if (hasAlpha === true) return { type: "image/png", extension: "png", quality: undefined };
  return { type: "image/jpeg", extension: "jpg", quality: JPEG_QUALITY };
}

async function shrink(file, maxEdge = MAX_EDGE) {
  // Only images the browser can actually decode are resized. An SVG or a HEIC that
  // fails to decode is passed through untouched rather than being silently lost -
  // the server still validates the type and size.
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { blob: file, width: null, height: null, resized: false };

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  // Dimensions are read before close(), and the bitmap is always closed: a decoded
  // bitmap holds real memory, and an uploader that leaks one per image eventually
  // takes the tab down.
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  if (scale === 1) {
    bitmap.close();
    return { blob: file, width: sourceWidth, height: sourceHeight, resized: false };
  }

  // Alpha is decided BEFORE the canvas is drawn, because the decision determines
  // what the canvas is encoded as.
  const alpha = await hasRealAlpha(bitmap);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return { blob: file, width: sourceWidth, height: sourceHeight, resized: false };
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const output = planImageOutput({ hasAlpha: alpha });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, output.type, output.quality));
  if (!blob) return { blob: file, width: sourceWidth, height: sourceHeight, resized: false };
  return { blob, width, height, resized: true, alpha: alpha === true };
}

/**
 * The extension the server expects for a MIME type. This has to be derived from
 * what the resize PRODUCED, never from the filename that came in.
 *
 * The bug this fixes: shrink() always re-encodes to JPEG, so a PNG arrives at the
 * server named "photo.png" with type "image/jpeg". The server compares the two and
 * refuses with "Type and extension disagree" - which made every non-JPEG upload
 * fail silently. Deriving the name from the produced type means the pair always
 * agrees, whatever the operator picked.
 */
const EXTENSION_FOR_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

/**
 * The uploader. `onUploaded(row)` receives the media record the server made, so the
 * caller can attach the key. Progress and errors are shown here rather than left to
 * the caller, because "did my upload work" is the question at this exact moment -
 * and a failed upload that says nothing is worse than no uploader at all.
 */
export function adminImageUploader({ productId, onUploaded, accept = "image/jpeg,image/png,image/webp,image/avif", onError }) {
  const input = el("input", { type: "file", accept, class: "sr-only", multiple: false });
  const status = el("span", { class: "upload-status", role: "status" });
  const preview = el("div", { class: "upload-preview" });

  async function handle(file) {
    if (!file) return;
    status.textContent = "Resizing…";
    try {
      const { blob, width, height, resized } = await shrink(file);
      const type = blob.type || file.type;
      const extension = EXTENSION_FOR_TYPE[type] || "jpg";
      const base = (file.name || "upload").replace(/\.[^.]*$/, "") || "upload";

      const form = new FormData();
      // The content hash is computed HERE, in the admin's browser, and sent as a
      // header - never inside the Worker. Hashing a 10MB upload costs more CPU than
      // a free-plan Worker gets in a request, and the browser already has the bytes
      // in memory and a crypto.subtle implementation sitting right there.
      const sha256 = await sha256Of(blob);
      if (sha256) form.append("sha256", sha256);
      form.append("file", new File([blob], `${base}.${extension}`, { type }));
      if (productId) form.append("productId", String(productId));
      form.append("width", String(width ?? ""));
      form.append("height", String(height ?? ""));

      // Saying what the resize achieved is not decoration: an operator who picks a
      // 6 MB phone photo and sees "1.2 MB, 1400px" knows the upload did something.
      status.textContent = resized
        ? `Resized to ${width}×${height} (${formatBytes(file.size)} → ${formatBytes(blob.size)}). Uploading…`
        : `Uploading ${formatBytes(blob.size)}…`;

      const result = await api.upload("/media", form);
      status.textContent = "";
      onUploaded(result.media);
    } catch (err) {
      // The server's own words, in the uploader. Swallowing this was the second half
      // of "you can select a file but nothing happens": the rejection used to be
      // re-thrown into the change listener, where nothing was listening for it.
      status.textContent = "";
      const message = err instanceof ApiError ? err.message : String(err?.message || err);
      status.classList.add("is-error");
      status.textContent = message;
      if (onError) onError(err);
      else toast(message, "error", 8000);
    }
  }

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    // Reset first, so picking the SAME file twice in a row still fires a change.
    input.value = "";
    void handle(file);
  });

  return el("div", { class: "uploader" },
    input,
    el("button", { class: "button", type: "button", text: "Choose image…", onclick: () => input.click() }),
    status,
    preview);
}

/* -------------------------------------------------------- state blocks */

/** The one thing a failed list must show: what went wrong, and a way to retry. */
export function errorState(err, onRetry) {
  return el("div", { class: "table-state table-state-error" },
    el("p", { class: "table-state-title", text: "Could not load this list" }),
    el("p", { class: "muted", text: err?.message || String(err) }),
    onRetry ? el("button", { class: "button", type: "button", text: "Try again", onclick: onRetry }) : null);
}

/** A read-only key/value list, for a detail view. */
export function definitionList(pairs) {
  return el("dl", { class: "detail-list" }, pairs.filter(Boolean).flatMap(([term, value]) => [
    el("dt", { text: term }),
    el("dd", {}, value === null || value === undefined || value === "" ? el("span", { class: "muted", text: "—" }) : value),
  ]));
}


