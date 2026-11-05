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

test("device and session management UI calls their real mutation endpoints", () => {
  const devices = read("devices.js");
  const sessions = read("sessions.js");
  assert.match(devices, /\$\{ADMIN_BASE\}\/admin-v2\/devices/, "loads devices from the admin namespace");
  assert.match(devices, /method: "DELETE"/, "revokes a device");
  assert.match(devices, /\/devices\/invite/, "creates a device invite");
  assert.match(sessions, /\$\{ADMIN_BASE\}\/auth\/sessions/, "loads sessions from the auth namespace");
  assert.match(sessions, /\/auth\/sessions\/revoke-others/, "revokes other sessions");
  assert.match(sessions, /method: "DELETE"/, "revokes an individual session");
  assert.match(sessions, /response\.ok/, "reports mutation failures instead of falsely succeeding");
});
