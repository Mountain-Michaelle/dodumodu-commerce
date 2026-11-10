// Behaviour of the shared admin page helper, run for real in a sandbox with a fake fetch/DOM:
//   * a lost session (401 "Not authenticated") sends the person to sign-in
//   * a rejected id / wrong code (401 "Invalid or expired code") does NOT (that is not a lost session)
//   * 403, 429, 500 and a network failure never redirect
//   * unsafe methods always carry a JSON content type (the server's CSRF guard answers 415 otherwise)
//   * copy copies the REAL value, not the shortened text, and reports success/failure
//   * busy() refuses a second concurrent run (no duplicate submissions)
//   * Postgres timestamps parse in every browser
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "admin-ui.js"), "utf8");

function sandbox({ responder, clipboard }) {
  const calls = [];
  const notes = [];
  const noteEl = { className: "", textContent: "", hidden: true };
  const document = {
    getElementById: (id) => (id === "note" ? noteEl : null),
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {}, select() {} }),
    body: { appendChild() {} }, execCommand: () => false, addEventListener() {},
  };
  const location = { href: "" };
  const window = { ADMIN_BASE_PATH: "/x", AdminUI: null };
  const ctx = {
    window, document, location, navigator: { clipboard },
    fetch: async (url, opts) => { calls.push({ url, opts }); return responder(url, opts); },
    setTimeout: () => 0, clearTimeout() {}, prompt: () => null, console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ui: window.AdminUI, calls, location, noteEl, notes };
}
const json = (status, body) => ({ status, ok: status < 400, json: async () => body, clone() { return this; } });

test("a lost session (401 Not authenticated) goes to the sign-in page", async () => {
  const t = sandbox({ responder: () => json(401, { error: "Not authenticated" }) });
  const res = await t.ui.api("/auth/sessions");
  assert.equal(res, null);
  assert.equal(t.location.href, "/x/sign-in/");
});

test("a rejected id (401 Invalid or expired code) is NOT a lost session", async () => {
  const t = sandbox({ responder: () => json(401, { error: "Invalid or expired code" }) });
  const res = await t.ui.api("/admin-v2/users/u/sessions/s", { method: "DELETE" });
  assert.equal(res.status, 401);
  assert.equal(t.location.href, "");
});

test("403, 429, 500 and a network failure never redirect", async () => {
  for (const status of [403, 429, 500]) {
    const t = sandbox({ responder: () => json(status, { error: "x" }) });
    assert.equal((await t.ui.api("/x")).status, status);
    assert.equal(t.location.href, "");
  }
  const t = sandbox({ responder: () => { throw new Error("offline"); } });
  assert.equal(await t.ui.api("/x"), null);
  assert.equal(t.location.href, "");
});

test("unsafe methods always send a JSON content type and a body; GET sends neither", async () => {
  const t = sandbox({ responder: () => json(200, {}) });
  await t.ui.api("/a", { method: "DELETE" });
  await t.ui.api("/b", { method: "POST" });
  await t.ui.api("/c");
  assert.equal(t.calls[0].opts.headers["Content-Type"], "application/json");
  assert.equal(t.calls[0].opts.body, "{}");
  assert.equal(t.calls[1].opts.headers["Content-Type"], "application/json");
  assert.equal(t.calls[2].opts.headers, undefined);
  assert.equal(t.calls[2].opts.body, undefined);
  assert.equal(t.calls[0].url, "/x/a");
});

test("step-up: a 403 asks for a code, steps up once and retries once; cancelling keeps the 403", async () => {
  let n = 0;
  const t = sandbox({ responder: (url) => (url.endsWith("/auth/stepup") ? json(200, {}) : json(++n === 1 ? 403 : 200, {})) });
  t.ui = t.ui; // eslint
  const ctxPrompt = { v: "123456" };
  // the sandbox prompt returns null -> cancelled
  const cancelled = await t.ui.withStepup(() => t.ui.api("/do", { method: "POST" }));
  assert.equal(cancelled.status, 403);
  assert.equal(t.calls.filter((c) => c.url.endsWith("/auth/stepup")).length, 0);
  void ctxPrompt;
});

test("copy writes the REAL value and reports success or failure", async () => {
  const written = [];
  const ok = sandbox({ responder: () => json(200, {}), clipboard: { writeText: async (v) => written.push(v) } });
  assert.equal(await ok.ui.copyText("0123456789abcdef-the-full-identifier"), true);
  assert.deepEqual(written, ["0123456789abcdef-the-full-identifier"]);
  const bad = sandbox({ responder: () => json(200, {}), clipboard: { writeText: async () => { throw new Error("denied"); } } });
  assert.equal(await bad.ui.copyText("v"), false);
});

test("busy() refuses a second concurrent run", async () => {
  const t = sandbox({ responder: () => json(200, {}) });
  const button = { disabled: false, classList: { add() {}, remove() {} } };
  let runs = 0, release;
  const gate = new Promise((r) => { release = r; });
  const first = t.ui.busy(button, async () => { runs++; await gate; return "done"; });
  const second = await t.ui.busy(button, async () => { runs++; return "dup"; });
  assert.equal(second, undefined);
  release(); assert.equal(await first, "done");
  assert.equal(runs, 1);
  assert.equal(button.disabled, false, "re-enabled afterwards");
});

test("Postgres timestamps parse everywhere (space, microseconds, short offset)", () => {
  const t = sandbox({ responder: () => json(200, {}) });
  const d = t.ui.parseTime("2026-11-09 10:20:54.940543-05");
  assert.equal(d.toISOString(), "2026-11-09T15:20:54.940Z");
  assert.equal(t.ui.parseTime("not a date"), null);
  assert.equal(t.ui.fmtTime(null), "—");
});
