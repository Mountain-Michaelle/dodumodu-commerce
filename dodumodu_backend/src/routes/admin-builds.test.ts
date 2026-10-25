import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { adminRoute } from "./admin";
import { registerDbDriver } from "../db";
import { FakeDatabase, fakeDriver } from "../testSupport/fakeDb";
import type { Env } from "../env";

const env: Env = {
  DATABASE_URL: "fake://builds-test",
  DEPLOY_TRIGGER_SECRET: "ci-secret-token",
  SITE_URL: "https://localhost",
} as unknown as Env;

function makeApp(db: FakeDatabase) {
  registerDbDriver(fakeDriver(db));
  const testApp = new Hono<{ Bindings: Env }>();
  testApp.route("/admin", adminRoute);
  return testApp;
}

// Clear database state between tests
function clearDb() {
  // Each test creates a new FakeDatabase(), so no explicit cleanup needed
  // This ensures no state carries over between tests
}

test("mark-deployed transitions triggered -> deployed", async () => {
  const db = new FakeDatabase();
  clearDb();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7 }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/admin/builds/build_test_1/mark-deployed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
    }),
    env as never,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "deployed");
});

test("mark-deployed is idempotent (already deployed)", async () => {
  const db = new FakeDatabase();
  clearDb();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7 }],
      status: "deployed",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/admin/builds/build_test_1/mark-deployed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
    }),
    env as never,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "deployed");
});

test("mark-verified with matching markers succeeds", async () => {
  const db = new FakeDatabase();
  clearDb();
  // Use a timestamp that is clearly distinct - this helps the fake DB's
  // getLatest return the correct build even with orderBy being a no-op
  const fixedTs = new Date("2024-01-15T10:00:00Z").toISOString();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7 }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: fixedTs,
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: URL | RequestInfo) => {
    if (String(url).includes("/glow-serum/")) {
      return new Response(
        '<html><meta name="storefront-publish-id" content="pub_7"><meta name="storefront-build-id" content="build_test_1"></html>',
      );
    }
    return new Response("Not found", { status: 404 });
  };
  try {
    const res = await app.fetch(
      new Request("https://localhost/admin/builds/build_test_1/mark-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
      }),
      env as never,
    );
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "verified");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stale-build guard returns 409 when newer build exists", async () => {
  const db = new FakeDatabase();
  clearDb();
  // Build A (newer) with later timestamp
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_newer",
      intendedPublications: [{ slug: "newer-slug", publishId: 5 }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T11:00:00Z").toISOString(), // LATER timestamp
      verifiedAt: null,
      verificationError: null,
    },
    // Build B (older) with earlier timestamp
    {
      id: 2,
      buildId: "build_older",
      intendedPublications: [{ slug: "older-slug", publishId: 3 }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(), // EARLIER timestamp
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  // Try to verify the OLDER build when a NEWER build is in progress
  const res = await app.fetch(
    new Request("https://localhost/admin/builds/build_older/mark-verified", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
    }),
    env as never,
  );
  // The stale-build guard should return 409 because build_newer is newer
  assert.equal(res.status, 409, `Expected 409 stale-build guard, got ${res.status}`);
});

test("mark-verified rejects missing or wrong build secret", async () => {
  const db = new FakeDatabase();
  clearDb();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7 }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/admin/builds/build_test_1/mark-verified", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
    }),
    env as never,
  );
  assert.equal(res.status, 401, `Expected 401 for wrong secret, got ${res.status}`);
});

test("mark-verified is idempotent when already verified", async () => {
  const db = new FakeDatabase();
  clearDb();
  const fixedTs = new Date("2024-01-15T10:00:00Z").toISOString();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7 }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: fixedTs,
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: URL | RequestInfo) => {
    if (String(url).includes("/glow-serum/")) {
      return new Response(
        '<html><meta name="storefront-publish-id" content="pub_7"><meta name="storefront-build-id" content="build_test_1"></html>',
      );
    }
    return new Response("Not found", { status: 404 });
  };
  try {
    const res1 = await app.fetch(
      new Request("https://localhost/admin/builds/build_test_1/mark-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
      }),
      env as never,
    );
    assert.equal(res1.status, 200, `Expected 200, got ${res1.status}`);
    assert.equal((await res1.json() as { status: string }).status, "verified");

    // Second call returns the current verified state without re-verifying.
    const res2 = await app.fetch(
      new Request("https://localhost/admin/builds/build_test_1/mark-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
      }),
      env as never,
    );
    assert.equal(res2.status, 200, `Expected 200, got ${res2.status}`);
    assert.equal((await res2.json() as { status: string }).status, "verified");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mark-verified on a failed build stays failed (terminal state)", async () => {
  const db = new FakeDatabase();
  clearDb();
  const fixedTs = new Date("2024-01-15T10:00:00Z").toISOString();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7 }],
      status: "failed",
      triggeredBy: "ci@deploy",
      triggeredAt: fixedTs,
      verifiedAt: null,
      verificationError: "render failure",
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/admin/builds/build_test_1/mark-verified", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
    }),
    env as never,
  );
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  assert.equal((await res.json() as { status: string }).status, "failed");
});

test("mark-verified rejects marker mismatch and marks the build failed", async () => {
  const db = new FakeDatabase();
  clearDb();
  const fixedTs = new Date("2024-01-15T10:00:00Z").toISOString();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7 }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: fixedTs,
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: URL | RequestInfo) => {
    if (String(url).includes("/glow-serum/")) {
      // Public page carries a different publish id and build id.
      return new Response(
        '<html><meta name="storefront-publish-id" content="pub_9"><meta name="storefront-build-id" content="other_build"></html>',
      );
    }
    return new Response("Not found", { status: 404 });
  };
  try {
    const res = await app.fetch(
      new Request("https://localhost/admin/builds/build_test_1/mark-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
      }),
      env as never,
    );
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const body = (await res.json()) as { status: string; failures?: string[] };
    assert.equal(body.status, "failed");
    assert.ok(Array.isArray(body.failures) && body.failures.length > 0, "expected failure reasons");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The build must now be recorded as failed, never verified on a marker mismatch.
  const row = db.rows("site_builds").find((r) => r.buildId === "build_test_1");
  assert.ok(row, "expected the build row to exist");
  assert.equal(row.status, "failed");
});