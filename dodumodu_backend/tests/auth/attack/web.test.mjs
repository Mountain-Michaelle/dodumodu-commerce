// Web + enumeration attacks — spec §11. Runs against a live Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, maybe, call, readCode } from "./helpers.mjs";

maybe("cross-origin JSON POST is refused (Origin != Host)", async () => {
  const res = await fetch(BASE + "/auth/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ email: "x@y.com" }),
  });
  assert.equal(res.status, 403);
});

maybe("missing Origin on an unsafe method is refused", async () => {
  const res = await fetch(BASE + "/auth/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "x@y.com" }),
  });
  assert.equal(res.status, 403);
});

maybe("wrong content-type is refused (415)", async () => {
  const res = await fetch(BASE + "/auth/request", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: BASE },
    body: "email=x@y.com",
  });
  assert.equal(res.status, 415);
});

maybe("null Origin is refused", async () => {
  const res = await fetch(BASE + "/auth/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "null" },
    body: JSON.stringify({ email: "x@y.com" }),
  });
  assert.equal(res.status, 403);
});

maybe("unknown vs staff vs admin all answer 202 with the same body on /auth/request", async () => {
  const unknown = await call("/auth/request", { body: { email: "nobody-here@example.com" } });
  const staff = await call("/auth/request", { body: { email: "staff@example.com" } });
  assert.equal(unknown.status, 202);
  assert.equal(staff.status, 202);
  assert.deepEqual(unknown.data, staff.data); // identical { ok: true }
});

maybe("test mailbox is 404 without ALLOW_TEST_IP (deployed config)", async () => {
  // When the Worker runs WITHOUT ALLOW_TEST_IP this must be 404. If the harness
  // sets ALLOW_TEST_IP=1 this assertion is expected to be relaxed by the runner;
  // we still assert the route never leaks a code to an unknown path.
  const res = await fetch(BASE + "/auth/test/mailbox/definitely-not-a-user@example.com");
  assert.equal(res.status, 404);
});

maybe("SQL injection strings in email do not error the server", async () => {
  for (const evil of ["' OR 1=1--", "x'; DROP TABLE aa_users;--", '" onload=alert(1)@x.com']) {
    const r = await call("/auth/request", { body: { email: evil } });
    assert.equal(r.status, 202, `email ${evil} should still be 202`);
  }
});

maybe("oversized + malformed JSON does not 500", async () => {
  const big = "x".repeat(200000);
  const r1 = await fetch(BASE + "/auth/request", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email: big }),
  });
  assert.ok(r1.status === 202 || r1.status === 413, `got ${r1.status}`);
  const r2 = await fetch(BASE + "/auth/request", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE },
    body: "{not json",
  });
  assert.notEqual(r2.status, 500);
});

maybe("security headers present on an auth response", async () => {
  const r = await call("/auth/request", { body: { email: "x@y.com" } });
  assert.equal(r.res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.res.headers.get("x-frame-options"), "DENY");
  assert.match(r.res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
});

maybe("feature flag off => 404 (documented public auth routes)", async () => {
  // This only passes when the Worker is running with ADMIN_AUTH_V2=0. The attack
  // runner starts a second instance with the flag off to assert this; when it is
  // not provided the test is a no-op skip.
  if (!process.env.BASE_URL_FLAG_OFF) return;
  const res = await fetch(process.env.BASE_URL_FLAG_OFF + "/auth/request", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "x@y.com" }),
  });
  assert.equal(res.status, 404);
});
