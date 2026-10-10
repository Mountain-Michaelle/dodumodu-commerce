import { el, mount } from "../dom.js";
import { api, ApiError } from "../api.js";
import {
  adminField, fieldset, saveBar, readForm, applyFieldErrors, toast, toastError, errorState,
} from "../ui.js";

// Discount tiers and pay-on-delivery rules.
//
// Both are small, flat settings the storefront reads on every page load, so both
// are single-request screens rather than lists.
//
// The point worth restating is that these take effect on the NEXT order. An order
// already placed keeps the tier it was given, because its price is a snapshot - so
// editing a tier never rewrites what somebody was charged.

export function discountsView({ shell }) {
  let host;

  async function load() {
    mount(host, el("div", { class: "table-state" },
      el("div", { class: "spinner", "aria-hidden": "true" }),
      el("p", { class: "muted", text: "Loading tiers…" })));
    try {
      const { tiers } = await api.get("/discount-tiers");
      render(tiers || []);
    } catch (err) {
      mount(host, errorState(err, load));
    }
  }

  function render(existing) {
    // Always seeded with a quantity-1 tier: the API rejects a set without one,
    // because an un-tiered quantity has to resolve to a defined percentage.
    const rows = existing.length
      ? existing.map((t) => ({ ...t }))
      : [{ minQuantity: 1, discountPercent: 0, label: "", active: true }];
    const tbody = el("tbody");

    function paint() {
      mount(tbody, rows.map((tier, index) => el("tr", {},
        el("td", {}, el("input", {
          class: "input input-narrow", type: "number", min: 1, step: 1, value: tier.minQuantity,
          "aria-label": "Minimum quantity",
          oninput: (e) => { tier.minQuantity = Number(e.target.value) || 0; },
        })),
        el("td", {}, el("input", {
          class: "input input-narrow", type: "number", min: 0, max: 100, step: 1, value: tier.discountPercent,
          "aria-label": "Discount percent",
          oninput: (e) => { tier.discountPercent = Number(e.target.value) || 0; },
        })),
        el("td", {}, el("input", {
          class: "input", type: "text", value: tier.label || "", placeholder: "Shown on the product page",
          "aria-label": "Label",
          oninput: (e) => { tier.label = e.target.value; },
        })),
        el("td", {}, el("input", {
          type: "checkbox", checked: tier.active !== false, "aria-label": "Active",
          onchange: (e) => { tier.active = e.target.checked; },
        })),
        el("td", {}, el("button", {
          class: "button button-small button-danger", type: "button", text: "Remove",
          disabled: rows.length === 1,
          onclick: () => { rows.splice(index, 1); paint(); },
        })))));
    }
    paint();

    const form = el("form", { class: "form", onsubmit: (e) => e.preventDefault() },
      el("p", { class: "form-note" },
        "Takes effect on the next order placed. Orders already placed keep the discount they were actually given."),
      el("div", { class: "table-wrap" },
        el("table", { class: "table" },
          el("thead", {}, el("tr", {},
            el("th", { scope: "col", text: "From quantity" }),
            el("th", { scope: "col", text: "Discount %" }),
            el("th", { scope: "col", text: "Label" }),
            el("th", { scope: "col", text: "Active" }),
            el("th", { scope: "col", text: "" }))),
          tbody)),
      el("div", { class: "form-inline" },
        el("button", {
          class: "button", type: "button", text: "+ Add tier",
          onclick: () => { rows.push({ minQuantity: 1, discountPercent: 0, label: "", active: true }); paint(); },
        })),
      saveBar({
        saveLabel: "Save tiers",
        onSave: async () => {
          try {
            await api.put("/discount-tiers", rows.map((tier) => ({
              minQuantity: Number(tier.minQuantity),
              discountPercent: Number(tier.discountPercent),
              label: tier.label || null,
              active: tier.active !== false,
            })));
            toast("Discount tiers saved", "success");
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

    mount(host, form);
  }

  return {
    start() {
      host = el("div");
      mount(shell.content,
        el("div", { class: "list-panel" },
          el("div", { class: "list-head" }, el("h2", { class: "list-title", text: "Quantity discounts" })),
          el("div", { class: "panel-body" }, host)));
      load();
    },
  };
}

export function paymentView({ shell }) {
  let host;

  async function load() {
    mount(host, el("div", { class: "table-state" },
      el("div", { class: "spinner", "aria-hidden": "true" }),
      el("p", { class: "muted", text: "Loading rules…" })));
    try {
      const { paymentRules } = await api.get("/payment-rules");
      render(paymentRules);
    } catch (err) {
      mount(host, errorState(err, load));
    }
  }

  function render(rules) {
    const form = el("form", { class: "form", onsubmit: (e) => e.preventDefault() },
      fieldset({ legend: "Where pay on delivery is allowed", fields: [
        adminField({
          name: "codStates", label: "States", value: (rules.codStates || []).join(", "),
          hint: "Comma separated. “Abuja” and “FCT” count as one place, and “X State” is the same as “X”.",
        }),
      ] }),
      fieldset({ legend: "How much", fields: [
        adminField({
          name: "codBulkThreshold", label: "COD covers up to", type: "number",
          value: rules.codBulkThreshold ?? 1, min: 1, max: 20, step: 1,
          hint: "Set 5 to let quantities 1–4 pay on delivery and force 5 or more to pay first. Set 1 to switch it off entirely.",
        }),
      ] }),
      el("p", { class: "form-note" },
        "The server re-checks every order against these rules before it prices anything, so the storefront hiding the option is a convenience and not the control."),
      saveBar({
        saveLabel: "Save rules",
        onSave: async () => {
          const values = readForm(form);
          // Split, trim, drop blanks and de-duplicate. The API tidies again, but
          // sending "Lagos, , lagos" is a confusing round trip to watch happen.
          const seen = new Map();
          for (const state of values.codStates.split(",")) {
            const trimmed = state.trim();
            if (trimmed) seen.set(trimmed.toLowerCase(), trimmed);
          }
          try {
            const { paymentRules } = await api.put("/payment-rules", {
              codStates: [...seen.values()],
              codBulkThreshold: Number(values.codBulkThreshold) || 1,
            });
            toast(
              paymentRules.codStates.length
                ? `Saved. Pay on delivery applies in ${paymentRules.codStates.join(", ")} for up to ${paymentRules.codBulkThreshold - 1} item(s).`
                : "Saved with no states — pay on delivery is now switched off everywhere.",
              "success", 6000,
            );
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
    mount(host, form);
  }

  return {
    start() {
      host = el("div");
      mount(shell.content,
        el("div", { class: "list-panel" },
          el("div", { class: "list-head" }, el("h2", { class: "list-title", text: "Pay-on-delivery rules" })),
          el("div", { class: "panel-body" }, host)));
      load();
    },
  };
}
