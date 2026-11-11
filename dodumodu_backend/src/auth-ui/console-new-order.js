// "+ New order": manual order entry for the admin console's Orders section.
//
// Self-contained on purpose. It is appended to the console bundle (scripts/console-patch.mjs) but touches
// nothing inside it: it finds the Orders header in the DOM, adds a button, and talks to
// POST <admin>/admin-v2/orders. It shows only to users who hold the `orders.add` permission (the server
// checks the same key, so hiding the button is a convenience and never the protection).
(function () {
  "use strict";
  var base = location.pathname.replace(/\/+$/, "");
  var perms = null;          // null = not loaded yet
  var options = null;

  function api(method, path, body) {
    return fetch(base + "/admin-v2" + path, {
      method: method, credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && (j.error && j.error.message || j.error)) || "Request failed"); e.status = r.status; e.fields = j && (j.fields || (j.error && j.error.fields)); throw e; }
        return j;
      });
    });
  }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") el.className = attrs[k]; else if (k === "text") el.textContent = attrs[k];
      else if (k === "onclick") el.addEventListener("click", attrs[k]); else el.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.append(arguments[i]);
    return el;
  }
  function toast(text, kind) {
    var host = document.querySelector(".toasts") || document.body;
    var t = h("div", { class: "toast toast-" + (kind || "info"), text: text }); host.append(t);
    setTimeout(function () { t.remove(); }, 5000);
  }
  var naira = function (kobo) { return "₦" + (kobo / 100).toLocaleString("en-NG"); };

  function field(label, control, name) {
    var err = h("p", { class: "field-error", "data-error-for": name });
    return h("label", { class: "field" }, h("span", { class: "field-label", text: label }), control, err);
  }
  function input(name, type, extra) { return h("input", Object.assign({ class: "input", name: name, type: type || "text", autocomplete: "off" }, extra || {})); }
  function select(name, items, placeholder) {
    var s = h("select", { class: "select", name: name });
    if (placeholder) s.append(h("option", { value: "", text: placeholder }));
    items.forEach(function (o) { s.append(h("option", { value: String(o.value), text: o.label })); });
    return s;
  }

  function open() {
    var close = function () { overlay.remove(); document.removeEventListener("keydown", onKey); };
    var onKey = function (e) { if (e.key === "Escape") close(); };
    var body = h("div", { class: "modal-body" }, h("p", { class: "muted", text: "Loading…" }));
    var overlay = h("div", { class: "overlay", id: "aa-new-order-modal" },
      h("div", { class: "modal modal-wide", role: "dialog", "aria-modal": "true", "aria-label": "New order" },
        h("div", { class: "modal-head" }, h("h2", { class: "modal-title", text: "New order" }),
          h("button", { class: "icon-button", type: "button", "aria-label": "Close", text: "×", onclick: close })),
        body));
    document.addEventListener("keydown", onKey); document.body.append(overlay);
    (options ? Promise.resolve(options) : api("GET", "/orders/form-options")).then(function (o) { options = o; render(body, o, close); })
      .catch(function (e) { body.textContent = ""; body.append(h("p", { class: "field-error", text: e.message })); });
  }

  function render(body, o, close) {
    var key = (crypto.randomUUID ? crypto.randomUUID() : null);
    var product = select("productId", o.products.map(function (p) { return { value: p.id, label: p.name + " — " + naira(p.price) }; }), "Choose a product");
    var pack = select("packageId", []); var packWrap = field("Package", pack, "packageId");
    function syncPackages() {
      var p = o.products.filter(function (x) { return String(x.id) === product.value; })[0];
      pack.textContent = "";
      ((p && p.packageOptions) || []).forEach(function (x) { pack.append(h("option", { value: x.id, text: x.label + (x.price ? " — " + naira(x.price) : "") })); });
      packWrap.style.display = p && p.packageOptions && p.packageOptions.length ? "" : "none";
    }
    product.addEventListener("change", syncPackages); syncPackages();
    var f = {
      productId: field("Product", product, "productId"), packageId: packWrap,
      quantity: field("Quantity", input("quantity", "number", { min: "1", step: "1", value: "1" }), "quantity"),
      customerName: field("Customer name", input("customerName"), "customerName"),
      phone: field("Phone", input("phone", "tel", { placeholder: "08012345678" }), "phone"),
      whatsapp: field("WhatsApp", input("whatsapp", "tel", { placeholder: "08012345678" }), "whatsapp"),
      address: field("Delivery address", input("address"), "address"),
      state: field("State", select("state", o.states.map(function (s) { return { value: s, label: s }; }), "Choose a state"), "state"),
      deliveryDate: field("Delivery date", select("deliveryDate", o.deliveryDates), "deliveryDate"),
      paymentMethod: field("Payment", select("paymentMethod", o.paymentMethods), "paymentMethod"),
      questionNotes: field("Notes (optional)", input("questionNotes"), "questionNotes"),
    };
    var form = h("form", { class: "form", novalidate: "novalidate" },
      h("fieldset", { class: "fieldset" }, h("legend", { class: "fieldset-legend", text: "Order" }),
        h("div", { class: "field-grid field-grid-2" }, f.productId, f.packageId, f.quantity, f.paymentMethod)),
      h("fieldset", { class: "fieldset" }, h("legend", { class: "fieldset-legend", text: "Customer" }),
        h("div", { class: "field-grid field-grid-2" }, f.customerName, f.phone, f.whatsapp, f.state, f.deliveryDate, f.questionNotes)),
      h("fieldset", { class: "fieldset" }, h("div", { class: "field-grid field-grid-1" }, f.address)));
    var status = h("span", { class: "save-status", role: "status" });
    var save = h("button", { class: "button button-primary", type: "submit", text: "Create order" });
    form.append(h("div", { class: "save-bar" }, status, h("div", { class: "save-actions" },
      h("button", { class: "button", type: "button", text: "Cancel", onclick: close }), save)));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      form.querySelectorAll("[data-error-for]").forEach(function (n) { n.textContent = ""; });
      var v = {}; new FormData(form).forEach(function (val, k) { v[k] = String(val); });
      var payload = {
        productId: Number(v.productId), quantity: Number(v.quantity), customerName: v.customerName, phone: v.phone, whatsapp: v.whatsapp,
        address: v.address, state: v.state, deliveryDate: v.deliveryDate, paymentMethod: v.paymentMethod,
      };
      if (v.packageId) payload.packageId = v.packageId;
      if (v.questionNotes) payload.questionNotes = v.questionNotes;
      if (key) payload.idempotencyKey = key;
      save.disabled = true; status.textContent = "Saving…";
      api("POST", "/orders", payload).then(function (res) {
        close();
        toast("Order " + res.order.reference + " created" + (res.visibleToCreator === false ? "" : "."), "success");
        window.dispatchEvent(new HashChangeEvent("hashchange"));   // the console reloads the Orders list
      }).catch(function (e) {
        save.disabled = false; status.textContent = "";
        var fields = e.fields || {}; var shown = false;
        Object.keys(fields).forEach(function (k) {
          var n = form.querySelector('[data-error-for="' + k + '"]'); if (n) { n.textContent = [].concat(fields[k])[0]; shown = true; }
        });
        if (!shown) status.textContent = e.message;
        if (e.status === 401 || e.status === 403) status.textContent = "You do not have permission to create orders.";
      });
    });
    body.textContent = ""; body.append(form);
  }

  function onOrders() { var hs = location.hash.replace(/^#/, "").split("/")[0]; return hs === "" || hs === "orders"; }
  function ensureButton() {
    if (perms === null || !onOrders()) return;
    if (!perms.has("orders.add")) return;
    var head = document.querySelector(".list-panel .list-head");
    if (!head || document.getElementById("aa-new-order")) return;
    var title = head.querySelector(".list-title");
    if (!title || title.textContent.trim() !== "All orders") return;
    head.append(h("button", { class: "button button-primary", type: "button", id: "aa-new-order", text: "+ New order", onclick: open }));
  }

  fetch(base + "/auth/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
    perms = new Set((me && me.perms) || []); ensureButton();
  }).catch(function () { perms = new Set(); });
  new MutationObserver(ensureButton).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", function () { setTimeout(ensureButton, 0); });
})();
