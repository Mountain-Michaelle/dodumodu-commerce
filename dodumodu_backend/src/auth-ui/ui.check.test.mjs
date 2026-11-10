// admin-auth v2 UI structural checks (no browser needed). Verifies:
//  - every getElementById target in the JS exists as an id in the HTML,
//  - no inline <script> (CSP script-src 'self' => external files only),
//  - the external script/stylesheet paths are the ones we ship.
// Run: node --test src/auth-ui/ui.check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), "utf8");
const ids = (html) => new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const referenced = (js) => new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));

const pages = [
  { html: "login.html", js: "auth.js" },
  { html: "sessions.html", js: "sessions.js" },
  { html: "devices.html", js: "devices.js" },
  { html: "users.html", js: "users.js" },
];

test("every JS getElementById target exists in its HTML", () => {
  for (const p of pages) {
    const present = ids(read(p.html));
    for (const id of referenced(read(p.js))) {
      assert.ok(present.has(id), `${p.js} references #${id} missing from ${p.html}`);
    }
  }
});

test("no inline scripts or handlers (CSP script-src 'self')", () => {
  for (const p of pages) {
    const html = read(p.html);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/, `${p.html} has an inline <script>`);
    assert.doesNotMatch(html, /\son\w+=/, `${p.html} has an inline event handler`);
  }
});

test("external asset paths are the shipped ones", () => {
  for (const p of pages) {
    const html = read(p.html);
    assert.match(html, /href="\/auth-ui\/auth\.css"/, `${p.html} must link the shared stylesheet`);
    assert.match(html, new RegExp(`src="\/auth-ui\/${p.js.replace(".", "\\.")}"`), `${p.html} must load ${p.js}`);
  }
});

test("auth flow endpoints match the backend routes", () => {
  const js = read("auth.js");
  assert.match(js, /AUTH \+ "\/request"/, "email stage posts /auth/request");
  assert.match(js, /AUTH \+ "\/code"/, "otp stage posts /auth/code");
  assert.match(js, /AUTH \+ "\/totp"/, "totp stage posts /auth/totp");
  assert.match(js, /AUTH \+ "\/totp\/enroll\/start"/, "enroll fetches /auth/totp/enroll/start once");
  assert.match(js, /AUTH \+ "\/backup-codes\/ack"/, "backup_codes stage posts /auth/backup-codes/ack");
  assert.match(js, /AUTH \+ "\/recovery\/backup-code"/, "recovery stage posts /auth/recovery/backup-code");
  assert.match(js, /AUTH \+ "\/session"/, "ready stage posts /auth/session");
  assert.doesNotMatch(js, /session\/ready/, "no dead /auth/session/ready call");
  assert.doesNotMatch(js, /enroll\/start\/pending/, "no dead /auth/totp/enroll/start/pending call");
  assert.doesNotMatch(js, /backup_entry/, "backend stage is recovery, not backup_entry");
});

test("recovery is reachable: backend unlocks it, UI routes it", () => {
  const js = read("auth.js");
  assert.match(js, /recovery_available/, "UI surfaces the server's recovery_available signal");
  assert.match(js, /case "recovery"/, "the recovery stage submits through the form");
});

test("autocomplete hints match the spec (one-time-code, no passwords)", () => {
  const js = read("auth.js");
  assert.match(js, /one-time-code/, "emailed code + TOTP + backup codes use one-time-code");
  assert.doesNotMatch(js, /current-password/, "recovery phrase removed: no current-password hint");
  assert.doesNotMatch(js, /new-password/, "recovery phrase removed: no new-password hint");
});

test("user management UI covers create, roles and permissions", () => {
  const html = read("users.html");
  const js = read("users.js");
  assert.match(html, /id="create-email"/);
  assert.match(html, /id="role-filter"/);
  assert.match(html, /id="permission-list"/);
  assert.match(js, /permissions\/registry/, "loads the server permission registry");
  assert.match(js, /JSON\.stringify\(\{ perms \}\)/, "saves the complete permission grant set");
  assert.match(js, /body: JSON\.stringify\(\{ role:/, "exposes role changes");
});

test("device and session management UI calls their real endpoints", () => {
  const devices = read("devices.js");
  const sessions = read("sessions.js");
  const users = read("users.js");
  assert.match(devices, /UI\.api\(`\/admin-v2\/devices\?\$\{p\}`\)/, "loads devices (all users, server-side search + paging)");
  assert.match(devices, /scope: "all"/, "asks for the all-owners view");
  assert.match(devices, /\/admin-v2\/users\/\$\{encodeURIComponent\(d\.user_id\)\}\/devices\/\$\{encodeURIComponent\(d\.id\)\}/, "revokes the right device of the right user");
  assert.match(devices, /method: "DELETE"/, "revokes a device");
  assert.match(devices, /\/admin-v2\/devices\/invite/, "creates a device invite");
  assert.match(sessions, /UI\.api\("\/auth\/sessions"\)/, "loads my sessions from the auth namespace");
  assert.match(sessions, /\/admin-v2\/sessions\?/, "loads every user's sessions (admin)");
  assert.match(sessions, /\/auth\/sessions\/revoke-others/, "revokes other sessions");
  assert.match(sessions, /method: "DELETE"/, "revokes an individual session");
  assert.match(sessions, /res\.ok/, "reports mutation failures instead of falsely succeeding");
  assert.match(users, /\/admin-v2\/users\?\$\{p\}/, "users list is searched and paged by the server");
  assert.match(users, /\/admin-v2\/users\/\$\{encodeURIComponent\(userId\)\}\/sessions\//, "user panels use the per-user session routes");
});

test("every management page loads the shared helper first", () => {
  for (const f of ["sessions", "devices", "users"]) {
    const html = read(`${f}.html`);
    const ui = html.indexOf('src="/auth-ui/admin-ui.js"'), page = html.indexOf(`src="/auth-ui/${f}.js"`);
    assert.ok(ui > -1 && page > ui, `${f}.html must load admin-ui.js before ${f}.js`);
  }
});

test("no hard-coded hosts and no innerHTML with server data in the UI scripts", () => {
  for (const f of ["admin-ui.js", "sessions.js", "devices.js", "users.js", "device-accept.js", "auth.js"]) {
    const js = read(f);
    assert.doesNotMatch(js, /localhost|127\.0\.0\.1|workers\.dev/, `${f} must not hard-code a host`);
  }
  for (const f of ["sessions.js", "devices.js", "users.js", "device-accept.js"]) {
    assert.doesNotMatch(read(f), /innerHTML/, `${f} must build the DOM with textContent only`);
  }
  // the one allowed innerHTML is the constant copy icon
  const ui = read("admin-ui.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal((ui.match(/innerHTML/g) || []).length, 1);
  assert.match(ui, /b\.innerHTML = COPY_ICON/);
});

test("scrollbars are hidden without disabling scrolling", () => {
  const css = read("auth.css");
  assert.match(css, /\.table-scroll::-webkit-scrollbar \{ display: none/);
  assert.match(css, /scrollbar-width: none/);
  assert.match(css, /\.table-scroll \{ overflow-x: auto/);
  assert.doesNotMatch(css.slice(css.indexOf(".table-scroll")), /\.table-scroll[^}]*overflow:\s*hidden/, "scrolling must stay enabled");
});

test("header and rows share one column template", () => {
  const css = read("auth.css");
  assert.match(css, /\.table-head, \.table-body \.row \{ display: grid; grid-template-columns: var\(--cols\)/);
  for (const page of ["sessions", "devices", "users"]) assert.match(css, new RegExp(`\\[data-page="${page}"\\]\\s+\\{ --cols:`));
});
