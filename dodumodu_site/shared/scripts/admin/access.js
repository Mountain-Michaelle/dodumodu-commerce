import { el } from "./dom.js";
import { api, v2api } from "./api.js";
import {
  adminTable, adminField, fieldset, saveBar, readForm, applyFieldErrors,
  statusBadge, toast, toastError, openModal, confirmDialog, definitionList,
} from "./ui.js";

// Access helpers shared by users.js: create/edit forms, the registry-driven
// permission MATRIX, danger ops, and the step-up retry. The MATRIX mirrors
// the server rules: unchecking a section auto-unchecks its dependents;
// checking a privilege auto-checks what it requires; admin-reserved items
// render locked. The server normalizes + audits; this screen only repeats
// the server's answer after save.

export async function dangerOp(title, body, run, close, onDone) {
  if (!await confirmDialog({ title, body, confirmLabel: "Confirm", danger: true })) return;
  try {
    await withStepUpRetry(run);
    toast("Done.", "success");
    close();
    onDone?.();
  } catch (err) { toastError(err); }
}

export function openEdit(user, onDone) {
  const form = el("form", { class: "form", onsubmit: (e) => e.preventDefault() },
    fieldset({ legend: "Edit user", fields: [
      adminField({ name: "first_name", label: "First name", value: user.firstName || "" }),
      adminField({ name: "last_name", label: "Last name", value: user.lastName || "" }),
      adminField({ name: "role", label: "Role", type: "select", value: user.role, options: [{ value: "mono", label: "Staff" }, { value: "general", label: "Mini admin" }, { value: "admin", label: "Admin" }], hint: "Takes effect on their next request." }),
      adminField({ name: "is_active", label: "Active", type: "checkbox", value: user.isActive }),
      adminField({ name: "is_staff", label: "May sign in", type: "checkbox", value: user.isStaff }),
    ] }),
    saveBar({
      saveLabel: "Save",
      onSave: async () => {
        const values = readForm(form);
        try {
          await withStepUpRetry(() => v2api.patch(`/users/${user.id}`, {
            first_name: values.first_name, last_name: values.last_name,
            role: values.role, is_active: values.is_active, is_staff: values.is_staff,
          }));
          toast("Saved.", "success");
          close();
          onDone?.();
        } catch (err) {
          if (err?.status === 400 && err.fields) { applyFieldErrors(form, err.fields); return; }
          toastError(err);
        }
      },
      onCancel: () => close(),
    }));
  const { close } = openModal({ title: `Edit ${user.username}`, render: () => form });
}

export async function openMatrix(user, held, onDone) {
  let registry;
  try {
    ({ registry } = await v2api.get("/permissions/registry"));
  } catch (err) { toastError(err); return; }
  const picked = new Set(held);
  const byGroup = new Map();
  for (const e of registry) {
    if (!byGroup.has(e.group)) byGroup.set(e.group, []);
    byGroup.get(e.group).push(e);
  }
  const diff = el("p", { class: "muted" });
  function repaint() {
    const cur = new Set(held);
    const added = [...picked].filter((k) => !cur.has(k));
    const removed = [...cur].filter((k) => !picked.has(k));
    diff.textContent = added.length || removed.length
      ? `Will add ${added.length}, remove ${removed.length}. Revoked sections cascade to their privileges.`
      : "No changes.";
  }
  const { close } = openModal({
    title: `Access — ${user.username}`,
    render: () => el("div", { class: "stack" },
      el("p", { class: "muted", text: "Sections gate whole areas; privileges gate single actions. Locked items are admin-reserved." }),
      [...byGroup].map(([group, entries]) => el("div", { class: "detail-section" },
        el("h3", { class: "detail-heading", text: group }),
        entries.map((e) => {
          const locked = e.adminOnly && user.role !== "admin";
          const box = el("input", {
            type: "checkbox", checked: picked.has(e.key), disabled: locked,
            "aria-label": e.label,
            onchange: (ev) => {
              if (ev.target.checked) {
                picked.add(e.key);
                for (const req of (e.requires || [])) picked.add(req);
              } else {
                picked.delete(e.key);
                for (const o of registry) {
                  if ((o.requires || []).includes(e.key)) picked.delete(o.key);
                }
              }
              repaint();
            },
          });
          return el("label", { class: "check-row" }, box,
            el("span", {}, el("span", { class: "strong", text: e.label }), el("span", { class: "muted", text: ` ${e.key}${locked ? " · admin-reserved" : ""}` })));
        }))),
      diff,
      el("div", { class: "detail-actions" },
        el("button", {
          class: "button button-primary", type: "button", text: "Save access",
          onclick: async () => {
            try {
              await withStepUpRetry(() => v2api.put(`/users/${user.id}/permissions`, { perms: [...picked] }));
              toast("Access saved. Applies on their next request.", "success");
              close();
              onDone?.();
            } catch (err) { toastError(err); }
          },
        }))),
  });
  repaint();
}

/** Step-up retry: 403 without a fresh window — prompt once, retry once. */
export async function withStepUpRetry(run) {
  try {
    return await run();
  } catch (err) {
    if (err?.status !== 403) throw err;
    const code = window.prompt("Re-enter your authenticator code to confirm this sensitive action:");
    if (!code) throw err;
    // Step-up lives on /auth (authRoute), NOT under /admin-v2 (v2api).
    // api.post builds ${ADMIN_BASE}${path} -> ${ADMIN_BASE}/auth/stepup,
    // matching the backend route registered at src/auth/routes.ts:376.
    await api.post("/auth/stepup", { code }).catch(() => { throw err; });
    return run();
  }
}

export function openCreate(onDone) {
  const form = el("form", { class: "form", onsubmit: (e) => e.preventDefault() },
    fieldset({ legend: "New user", fields: [
      adminField({ name: "email", label: "Email", type: "email", required: true, hint: "The login identifier. Must be unique." }),
      adminField({ name: "username", label: "Username", hint: "3–30 chars. Defaults to the email local part." }),
      adminField({ name: "role", label: "Role", type: "select", value: "mono", options: [{ value: "mono", label: "Staff" }, { value: "general", label: "Mini admin" }, { value: "admin", label: "Admin" }] }),
    ] }),
    saveBar({
      saveLabel: "Create user",
      onSave: async () => {
        const values = readForm(form);
        try {
          await withStepUpRetry(() => v2api.post("/users", { email: values.email, username: values.username || undefined, role: values.role }));
          toast("User created. They enroll TOTP + phrase at first login.", "success");
          close();
          onDone?.();
        } catch (err) {
          if (err?.status === 400 && err.fields) { applyFieldErrors(form, err.fields); return; }
          toastError(err);
        }
      },
      onCancel: () => close(),
    }));
  const { close } = openModal({ title: "Add user", render: () => form });
}
