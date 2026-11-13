// "Abuse & spam" for the admin console: held (spam) orders and rotating-phone-flood ("RPF") suspects.
//
// Self-contained on purpose, like console-new-order.js. It is appended to the console bundle (scripts/console-patch.mjs)
// and touches nothing inside it: it adds one sidebar link and opens a panel over the page. Everything it shows comes from
// <admin>/abuse/*, which the server only answers to administrators; blocking additionally needs a fresh authenticator
// code (the same step-up the console asks for elsewhere). Hiding the link from other roles is a convenience, never the
// protection. All server text is written with textContent, never as HTML.
(function () {
  "use strict";
  var base = location.pathname.replace(/\/+$/, "");
  var me = null;                 // null until /auth/me answers; the link exists only for administrators
  var counts = null;
  var panel = null;

  function api(method, path, body) {
    return fetch(base + path, {
      method: method, credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && (j.error && j.error.message || j.error)) || "Request failed"); e.status = r.status; throw e; }
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
    setTimeout(function () { t.remove(); }, 6000);
  }
  function when(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }); }
  function badge(text, kind) { return h("span", { class: "badge" + (kind ? " badge-" + kind : ""), text: text }); }
  function sel(items, value) {
    var s = h("select", { class: "select" });
    items.forEach(function (o) { var op = h("option", { value: o[0], text: o[1] }); if (o[0] === value) op.selected = true; s.append(op); });
    return s;
  }
  function query(obj) {
    var p = []; Object.keys(obj).forEach(function (k) { if (obj[k]) p.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])); });
    return p.length ? "?" + p.join("&") : "";
  }
  function table(headers, rows, empty) {
    if (!rows.length) return h("p", { class: "muted", text: empty });
    var t = h("table", { class: "table" });
    t.append(h("thead", {}, h("tr", {}, headers.map(function (x) { return h("th", { text: x }); }))));
    var tb = h("tbody"); rows.forEach(function (r) { tb.append(r); }); t.append(tb);
    return h("div", { style: "overflow-x:auto" }, t);
  }
  function td(content) { var c = h("td"); if (content && content.nodeType) c.append(content); else c.textContent = content == null ? "" : String(content); return c; }

  // ------------------------------------------------------------------ badge + polling
  function paintBadge() {
    var b = document.getElementById("aa-abuse-badge"); if (!b) return;
    var n = counts ? counts.heldOpen + counts.rpfOpen : 0;
    b.textContent = String(n); b.style.display = n > 0 ? "" : "none";
  }
  function refreshCounts(announce) {
    return api("GET", "/abuse/summary").then(function (s) {
      var before = counts; counts = s; paintBadge();
      if (announce && before) {
        if (s.rpfOpen > before.rpfOpen) toast("RPF suspect: one device or address is ordering under many phone numbers. Open Abuse & spam.", "warn");
        if (s.heldOpen > before.heldOpen) toast("An order was held as spam. Open Abuse & spam to review it.", "warn");
      }
    }).catch(function () { /* polling must never disturb the console */ });
  }

  // ------------------------------------------------------------------ nav link
  function ensureLink() {
    if (!me || me.role !== "admin" || document.getElementById("aa-abuse-group")) return;
    var nav = document.querySelector(".sidebar-nav"); if (!nav) return;
    var badgeEl = h("span", { class: "nav-badge", id: "aa-abuse-badge", style: "display:none;margin-left:6px" });
    var link = h("a", { class: "nav-link", href: "#abuse", id: "aa-abuse-link", onclick: function (e) { e.preventDefault(); openPanel("spam"); } },
      document.createTextNode("Abuse & spam"), badgeEl);
    nav.append(h("div", { class: "nav-group", id: "aa-abuse-group" }, h("h2", { class: "nav-group-title", text: "Security" }), h("ul", { class: "nav-list" }, h("li", {}, link))));
    paintBadge();
  }

  // ------------------------------------------------------------------ panel
  function openPanel(tab) {
    if (panel) panel.remove();
    var state = { tab: tab || "spam" };
    var content = h("div", { class: "stack" });
    var tabs = h("div", { class: "toolbar" });
    var close = function () { if (panel) { panel.remove(); panel = null; } document.removeEventListener("keydown", onKey); refreshCounts(false); };
    var onKey = function (e) { if (e.key === "Escape" && !document.getElementById("aa-abuse-dialog")) close(); };
    panel = h("div", { class: "overlay", id: "aa-abuse-panel" },
      h("div", { class: "modal modal-wide", role: "dialog", "aria-modal": "true", "aria-label": "Abuse and spam", style: "max-width:1100px;width:96vw" },
        h("div", { class: "modal-head" }, h("h2", { class: "modal-title", text: "Abuse & spam" }),
          h("button", { class: "icon-button", type: "button", "aria-label": "Close", text: "×", onclick: close })),
        h("div", { class: "modal-body" }, tabs, content)));
    document.addEventListener("keydown", onKey); document.body.append(panel);

    function drawTabs() {
      tabs.textContent = "";
      [["spam", "Spam orders" + (counts && counts.heldOpen ? " (" + counts.heldOpen + ")" : "")],
       ["rpf", "RPF Suspects" + (counts && counts.rpfOpen ? " (" + counts.rpfOpen + ")" : "")],
       ["tagged", "RPF orders"]].forEach(function (t) {
        tabs.append(h("button", { class: "button button-small" + (state.tab === t[0] ? " button-primary" : ""), type: "button", text: t[1],
          onclick: function () { state.tab = t[0]; show(); } }));
      });
    }
    function show() {
      drawTabs(); content.textContent = "";
      (state.tab === "spam" ? spamTab : state.tab === "rpf" ? rpfTab : taggedTab)(content, show);
    }
    refreshCounts(false).then(show);
  }

  // ------------------------------------------------------------------ Spam orders
  function spamTab(root, reload) {
    var status = sel([["held", "Held"], ["released", "Released"], ["dismissed", "Dismissed (spam)"], ["all", "All"]], "held");
    var search = h("input", { class: "input", type: "search", placeholder: "Phone, name, IP or reference" });
    var from = h("input", { class: "input", type: "date", "aria-label": "From" }), to = h("input", { class: "input", type: "date", "aria-label": "To" });
    var out = h("div");
    function load() {
      out.textContent = ""; out.append(h("p", { class: "muted", text: "Loading…" }));
      api("GET", "/abuse/held" + query({ status: status.value, q: search.value.trim(), from: from.value, to: to.value ? to.value + "T23:59:59" : "" })).then(function (r) {
        var rows = [];
        r.held.forEach(function (x) {
          var details = h("tr", { style: "display:none" }, h("td", { colspan: "9" }, detailList(x)));
          var actions = h("div", { class: "toolbar" });
          if (x.status === "held") {
            actions.append(h("button", { class: "button button-small button-primary", type: "button", text: "Release as order", onclick: function () {
              if (!window.confirm("Create a real order for " + x.customerName + " (" + x.phone + ")?")) return;
              api("POST", "/abuse/held/" + x.id + "/release", {}).then(function (res) { toast("Released: order " + res.reference + " created.", "success"); refreshCounts(false); load(); })
                .catch(function (e) { toast(e.message, "error"); load(); });
            } }));
            actions.append(h("button", { class: "button button-small", type: "button", text: "Confirm spam", onclick: function () {
              api("POST", "/abuse/held/" + x.id + "/dismiss", {}).then(function () { refreshCounts(false); load(); }).catch(function (e) { toast(e.message, "error"); load(); });
            } }));
          }
          actions.append(h("button", { class: "button button-small", type: "button", text: "Details", onclick: function () { details.style.display = details.style.display === "none" ? "" : "none"; } }));
          rows.push(h("tr", {}, td(when(x.createdAt)), td(x.customerName), td(x.phone), td(x.reason), td(x.ip || "—"), td(x.device || "—"),
            td(x.browser || "—"), td(badge(x.status, x.status === "held" ? "warn" : x.status === "released" ? "ok" : "danger")), td(actions)), details);
        });
        out.textContent = "";
        out.append(h("p", { class: "muted", text: r.total + " order" + (r.total === 1 ? "" : "s") + ". Held orders were never saved to the orders list; the customer saw a normal confirmation." }),
          table(["Received", "Customer", "Phone", "Why held", "IP", "Device", "Browser", "Status", ""], rows, "Nothing here."));
      }).catch(function (e) { out.textContent = ""; out.append(h("p", { class: "field-error", text: e.message })); });
    }
    [status, from, to].forEach(function (c) { c.addEventListener("change", load); });
    search.addEventListener("keydown", function (e) { if (e.key === "Enter") load(); });
    root.append(h("div", { class: "toolbar" }, status, search, from, to, h("button", { class: "button button-small", type: "button", text: "Search", onclick: load })), out);
    load();
  }
  function detailList(x) {
    var d = h("div", { class: "stack" }); d.append(h("p", { class: "muted", text: "Reference shown to the customer: " + x.reference + " · Address: " + x.address + " · Emailed: " + (x.emailed ? "yes" : "no") }));
    var items = x.items || {};
    d.append(h("p", { text: Object.keys(items).filter(function (k) { return items[k] !== null && items[k] !== "" && k !== "idempotencyKey"; }).map(function (k) { return k + ": " + String(items[k]); }).join("  ·  ") }));
    if (x.resolvedBy) d.append(h("p", { class: "muted", text: "Handled by " + x.resolvedBy + " " + when(x.resolvedAt) }));
    return d;
  }

  // ------------------------------------------------------------------ RPF suspects
  function rpfTab(root) {
    var status = sel([["open", "Open"], ["blocked", "Blocked"], ["dismissed", "Dismissed"], ["all", "All"]], "open");
    var scope = sel([["", "Address or device"], ["ip", "Address"], ["device", "Device"]], "");
    var search = h("input", { class: "input", type: "search", placeholder: "IP, device or browser" });
    var out = h("div");
    function load() {
      out.textContent = ""; out.append(h("p", { class: "muted", text: "Loading…" }));
      api("GET", "/abuse/rpf" + query({ status: status.value, scope: scope.value, q: search.value.trim() })).then(function (r) {
        var rows = r.suspects.map(function (x) {
          var actions = h("div", { class: "toolbar" });
          if (x.status === "open") {
            actions.append(h("button", { class: "button button-small button-danger", type: "button", text: "Block…", onclick: function () { blockDialog(x, function () { refreshCounts(false); load(); }); } }));
            actions.append(h("button", { class: "button button-small", type: "button", text: "Not a flood", onclick: function () {
              api("POST", "/abuse/rpf/" + x.id + "/dismiss", {}).then(function () { refreshCounts(false); load(); }).catch(function (e) { toast(e.message, "error"); load(); });
            } }));
          }
          return h("tr", {}, td(when(x.createdAt)), td(x.scope === "ip" ? "Address" : "Device"), td(x.ip || "—"), td(x.device || "—"),
            td((x.browser || "—") + (x.clientKind ? " (" + x.clientKind + ")" : "")), td(x.distinctPhones + " phones / " + x.orderCount + " orders in " + x.windowMinutes + " min"),
            td(badge(x.status === "open" ? "RPF Suspect" : x.status, x.status === "open" ? "warn" : x.status === "blocked" ? "danger" : "")), td(actions));
        });
        out.textContent = "";
        out.append(h("p", { class: "muted", text: r.total + " suspect" + (r.total === 1 ? "" : "s") + ". Their orders are saved normally; nothing is blocked until you do it here." }),
          table(["Raised", "Seen as", "IP", "Device", "Browser", "Evidence", "Status", ""], rows, "No suspects."));
      }).catch(function (e) { out.textContent = ""; out.append(h("p", { class: "field-error", text: e.message })); });
    }
    [status, scope].forEach(function (c) { c.addEventListener("change", load); });
    search.addEventListener("keydown", function (e) { if (e.key === "Enter") load(); });
    root.append(h("div", { class: "toolbar" }, status, scope, search, h("button", { class: "button button-small", type: "button", text: "Search", onclick: load })), out);
    load();
  }

  // Orders that belong to an open RPF alert, via the ordinary orders list filter.
  function taggedTab(root) {
    var search = h("input", { class: "input", type: "search", placeholder: "Reference, phone or name" });
    var out = h("div");
    function load() {
      out.textContent = ""; out.append(h("p", { class: "muted", text: "Loading…" }));
      fetch(base + "/admin-v2/orders" + query({ abuseTag: "rpf_suspect", search: search.value.trim(), limit: "100" }), { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("Could not load orders")); }).then(function (r) {
          var rows = r.orders.map(function (o) {
            return h("tr", {}, td(when(o.createdAt)), td(o.reference), td(o.customerName), td(o.phone), td(o.status), td(o.createdFromIp || "—"), td(o.deviceId ? o.deviceId.slice(0, 6) + "…" : "—"));
          });
          out.textContent = ""; out.append(table(["Placed", "Reference", "Customer", "Phone", "Status", "IP", "Device"], rows, "No RPF-tagged orders."));
        }).catch(function (e) { out.textContent = ""; out.append(h("p", { class: "field-error", text: e.message })); });
    }
    search.addEventListener("keydown", function (e) { if (e.key === "Enter") load(); });
    root.append(h("div", { class: "toolbar" }, search, h("button", { class: "button button-small", type: "button", text: "Search", onclick: load })), out);
    load();
  }

  // ------------------------------------------------------------------ block dialog (admin + authenticator code)
  function blockDialog(x, done) {
    var ipBox = h("input", { type: "checkbox", id: "aa-b-ip" }), devBox = h("input", { type: "checkbox", id: "aa-b-dev" });
    if (x.ip) ipBox.checked = true; else ipBox.disabled = true;
    if (x.hasDevice) devBox.checked = true; else devBox.disabled = true;
    var reason = h("input", { class: "input", type: "text", placeholder: "Why (required)", value: "Rotating phone numbers (RPF)" });
    var length = sel([["3600", "1 hour"], ["86400", "24 hours"], ["604800", "7 days"], ["", "Until I lift it"]], "86400");
    var code = h("input", { class: "input", type: "text", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "6-digit authenticator code", maxlength: "10" });
    var codeWrap = h("label", { class: "field" }, h("span", { class: "field-label", text: "Authenticator code" }), code);
    var msg = h("p", { class: "field-error", role: "alert" });
    var ok = h("button", { class: "button button-danger", type: "button", text: "Block" });
    var dlg = h("div", { class: "overlay", id: "aa-abuse-dialog" },
      h("div", { class: "modal modal-narrow", role: "dialog", "aria-modal": "true", "aria-label": "Block" },
        h("div", { class: "modal-head" }, h("h2", { class: "modal-title", text: "Block this suspect" })),
        h("div", { class: "modal-body stack" },
          h("p", { class: "muted", text: "Browser: " + (x.browser || "unknown") + (x.clientKind ? " (" + x.clientKind + ")" : "") + ". A browser cannot be blocked by itself - blocking the device and the address stops it." }),
          h("label", { class: "field-checkbox" }, ipBox, document.createTextNode(" Block address " + (x.ip || "(none recorded)"))),
          h("label", { class: "field-checkbox" }, devBox, document.createTextNode(" Block device " + (x.device || "(none recorded)"))),
          h("label", { class: "field" }, h("span", { class: "field-label", text: "Reason" }), reason),
          h("label", { class: "field" }, h("span", { class: "field-label", text: "For how long" }), length),
          codeWrap, msg,
          h("div", { class: "toolbar" }, h("button", { class: "button", type: "button", text: "Cancel", onclick: function () { dlg.remove(); } }), ok))));
    document.body.append(dlg);
    codeWrap.style.display = "none";
    api("GET", "/auth/me").then(function (m) { if (m && !m.stepup_ok) codeWrap.style.display = ""; }).catch(function () {});
    function send() {
      return api("POST", "/abuse/rpf/" + x.id + "/block", { ip: ipBox.checked, device: devBox.checked, reason: reason.value.trim(), seconds: length.value ? Number(length.value) : null });
    }
    ok.addEventListener("click", function () {
      msg.textContent = "";
      if (!ipBox.checked && !devBox.checked) { msg.textContent = "Choose the address and/or the device."; return; }
      if (reason.value.trim().length < 3) { msg.textContent = "Give a reason."; return; }
      ok.disabled = true;
      var step = code.value.trim() ? api("POST", "/auth/stepup", { code: code.value.trim() }) : Promise.resolve();
      step.then(send).then(function (r) { dlg.remove(); toast("Blocked: " + r.blocked.join(" + "), "success"); done(); })
        .catch(function (e) {
          ok.disabled = false;
          if (e.status === 403 || e.status === 401) { codeWrap.style.display = ""; msg.textContent = code.value.trim() ? "That code was not accepted, or this needs an administrator." : "Enter your authenticator code to confirm (administrators only)."; code.focus(); }
          else msg.textContent = e.message;
        });
    });
  }

  // ------------------------------------------------------------------ start
  fetch(base + "/auth/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
    me = m; if (!me || me.role !== "admin") return;
    ensureLink(); refreshCounts(false);
    setInterval(function () { if (!document.hidden) refreshCounts(true); }, 60000);
    if (location.hash === "#abuse") openPanel("spam");
  }).catch(function () { me = null; });
  new MutationObserver(ensureLink).observe(document.documentElement, { childList: true, subtree: true });
})();
