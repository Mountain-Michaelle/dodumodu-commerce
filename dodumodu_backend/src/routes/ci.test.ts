import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { ciRoute } from "./ci";
import { served } from "../services/servedStorefront";
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
  testApp.route("/ci", ciRoute);
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
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/builds/build_test_1/mark-deployed", {
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
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "deployed",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/builds/build_test_1/mark-deployed", {
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
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: fixedTs,
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const originalRead = served.read;
  served.read = (slug) => (slug === "glow-serum" ? '<html><meta name="storefront-publish-id" content="pub_00000000000000000007"><meta name="storefront-build-id" content="build_test_1"></html>' : null);
  try {
    const res = await app.fetch(
      new Request("https://localhost/ci/builds/build_test_1/mark-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
      }),
      env as never,
    );
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "verified");
  } finally {
    served.read = originalRead;
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
      intendedPublications: [{ slug: "newer-slug", publishId: 5, publishRef: "pub_00000000000000000005" }],
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
      intendedPublications: [{ slug: "older-slug", publishId: 3, publishRef: "pub_00000000000000000003" }],
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
    new Request("https://localhost/ci/builds/build_older/mark-verified", {
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
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/builds/build_test_1/mark-verified", {
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
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: fixedTs,
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const originalRead = served.read;
  served.read = (slug) => (slug === "glow-serum" ? '<html><meta name="storefront-publish-id" content="pub_00000000000000000007"><meta name="storefront-build-id" content="build_test_1"></html>' : null);
  try {
    const res1 = await app.fetch(
      new Request("https://localhost/ci/builds/build_test_1/mark-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
      }),
      env as never,
    );
    assert.equal(res1.status, 200, `Expected 200, got ${res1.status}`);
    assert.equal((await res1.json() as { status: string }).status, "verified");

    // Second call returns the current verified state without re-verifying.
    const res2 = await app.fetch(
      new Request("https://localhost/ci/builds/build_test_1/mark-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
      }),
      env as never,
    );
    assert.equal(res2.status, 200, `Expected 200, got ${res2.status}`);
    assert.equal((await res2.json() as { status: string }).status, "verified");
  } finally {
    served.read = originalRead;
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
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "failed",
      triggeredBy: "ci@deploy",
      triggeredAt: fixedTs,
      verifiedAt: null,
      verificationError: "render failure",
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/builds/build_test_1/mark-verified", {
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
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: fixedTs,
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const originalRead = served.read;
  served.read = (slug) => (slug === "glow-serum" ? '<html><meta name="storefront-publish-id" content="pub_9"><meta name="storefront-build-id" content="other_build"></html>' : null);
  try {
    const res = await app.fetch(
      new Request("https://localhost/ci/builds/build_test_1/mark-verified", {
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
    served.read = originalRead;
  }

  // The build must now be recorded as failed, never verified on a marker mismatch.
  const row = db.rows("site_builds").find((r) => r.buildId === "build_test_1");
  assert.ok(row, "expected the build row to exist");
  assert.equal(row.status, "failed");
});

test("pre-deploy returns eligible when build is the latest and not terminal", async () => {
  const db = new FakeDatabase();
  clearDb();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  db.table("product_publishes", [
    { id: 7, productId: 1, payload: { slug: "glow-serum" }, publishedBy: "a@b.c", buildStatus: "triggered",
      publishRef: "pub_00000000000000000007", createdAt: new Date().toISOString() },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/builds/build_test_1/pre-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
    }),
    env as never,
  );
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  const body = (await res.json()) as { eligible: boolean; status: string };
  assert.equal(body.eligible, true);
  assert.equal(body.status, "triggered");
});

test("pre-deploy returns 409 when a newer build exists (stale build blocked)", async () => {
  const db = new FakeDatabase();
  clearDb();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_newer",
      intendedPublications: [{ slug: "newer-slug", publishId: 5, publishRef: "pub_00000000000000000005" }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T11:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
    {
      id: 2,
      buildId: "build_older",
      intendedPublications: [{ slug: "older-slug", publishId: 3, publishRef: "pub_00000000000000000003" }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/builds/build_older/pre-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
    }),
    env as never,
  );
  assert.equal(res.status, 409, `Expected 409 stale-build, got ${res.status}`);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Stale build");
});

test("pre-deploy returns 409 when build is already verified (terminal)", async () => {
  const db = new FakeDatabase();
  clearDb();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "verified",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: new Date("2024-01-15T10:30:00Z").toISOString(),
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/builds/build_test_1/pre-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
    }),
    env as never,
  );
  assert.equal(res.status, 409, `Expected 409, got ${res.status}`);
});

test("pre-deploy returns 404 when build does not exist", async () => {
  const db = new FakeDatabase();
  clearDb();
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/builds/nonexistent/pre-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
    }),
    env as never,
  );
  assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
});

test("pre-deploy rejects missing build secret", async () => {
  const db = new FakeDatabase();
  clearDb();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/builds/build_test_1/pre-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
    }),
    env as never,
  );
  assert.equal(res.status, 401, `Expected 401 for wrong secret, got ${res.status}`);
});

test("mark-failed transitions triggered -> failed", async () => {
  const db = new FakeDatabase();
  clearDb();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "triggered",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: null,
    },
  ]);
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/builds/build_test_1/mark-failed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
      body: JSON.stringify({ error: "render failure" }),
    }),
    env as never,
  );
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "failed");

  const row = db.rows("site_builds").find((r) => r.buildId === "build_test_1");
  if (row) {
    assert.equal(row.status, "failed");
    assert.equal(row.verificationError, "render failure");
  }
});

test("duplicate mark-failed on an already-failed build is idempotent", async () => {
  const db = new FakeDatabase();
  clearDb();
  db.table("site_builds", [
    {
      id: 1,
      buildId: "build_test_1",
      intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
      status: "failed",
      triggeredBy: "ci@deploy",
      triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
      verifiedAt: null,
      verificationError: "first failure",
    },
  ]);
  const app = makeApp(db);

  const res1 = await app.fetch(
    new Request("https://localhost/ci/builds/build_test_1/mark-failed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ci-secret-token" },
      body: JSON.stringify({ error: "second failure" }),
    }),
    env as never,
  );
  assert.equal(res1.status, 200);

  const row = db.rows("site_builds").find((r) => r.buildId === "build_test_1");
  if (row) {
    assert.equal(row.verificationError, "first failure");
  }
});

test("deploy-trigger records a build with its intended publication set", async () => {
  const db = new FakeDatabase();
  clearDb();
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/deploy-trigger", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ci-secret-token",
      },
      body: JSON.stringify({
        buildId: "build_trigger_1",
        intendedPublications: [
          { slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" },
          { slug: "vitamin-c", publishId: 3, publishRef: "pub_00000000000000000003" },
        ],
      }),
    }),
    env as never,
  );
  assert.equal(res.status, 201, `Expected 201, got ${res.status}`);
  const body = (await res.json()) as { buildId: string; status: string; intendedPublications: Array<{slug: string; publishId: number}> };
  assert.equal(body.buildId, "build_trigger_1");
  assert.equal(body.status, "triggered");
  assert.equal(body.intendedPublications.length, 2);

  const row = db.rows("site_builds").find((r) => r.buildId === "build_trigger_1");
  assert.ok(row, "expected the build row to be recorded");
  assert.deepEqual(row.intendedPublications, [
    { slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" },
    { slug: "vitamin-c", publishId: 3, publishRef: "pub_00000000000000000003" },
  ]);
});

test("deploy-trigger rejects invalid body", async () => {
  const db = new FakeDatabase();
  clearDb();
  const app = makeApp(db);

  const res = await app.fetch(
    new Request("https://localhost/ci/deploy-trigger", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ci-secret-token",
      },
      body: JSON.stringify({ buildId: "", intendedPublications: "not-an-array" }),
    }),
    env as never,
  );
  const body = (await res.json()) as { error: string; fields?: Record<string, string[]> };
  assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
  assert.equal(body.error, "Invalid request");
});

test("pre-deploy returns 409 when a product was published again while the build ran", async () => {
  const db = new FakeDatabase();
  db.table("site_builds", [{
    id: 1, buildId: "build_test_1",
    intendedPublications: [{ slug: "glow-serum", publishId: 7, publishRef: "pub_00000000000000000007" }],
    status: "triggered", triggeredBy: "ci@deploy", triggeredAt: new Date("2024-01-15T10:00:00Z").toISOString(),
    verifiedAt: null, verificationError: null,
  }]);
  db.table("product_publishes", [
    { id: 9, productId: 1, payload: { slug: "glow-serum" }, publishedBy: "a@b.c", buildStatus: "triggered",
      publishRef: "pub_00000000000000000009", createdAt: new Date().toISOString() },
  ]);
  const res = await makeApp(db).fetch(
    new Request("https://localhost/ci/builds/build_test_1/pre-deploy", {
      method: "POST", headers: { Authorization: "Bearer ci-secret-token" },
    }),
    env as never,
  );
  assert.equal(res.status, 409);
});

test("events: a failed step fails the build with its message, and a finished build's log is closed", async () => {
  const db = new FakeDatabase();
  db.table("site_builds", [{
    id: 1, buildId: "build_test_1", intendedPublications: [], status: "triggered", triggeredBy: "ci@deploy",
    triggeredAt: new Date().toISOString(), verifiedAt: null, verificationError: null, lastEventAt: new Date().toISOString(),
    currentStep: null, failedStep: null, runUrl: null, triggerPublishId: null,
  }]);
  db.table("deploy_events", []);
  const app = makeApp(db);
  const send = (body: unknown) => app.fetch(new Request("https://localhost/ci/builds/build_test_1/events", {
    method: "POST", headers: { Authorization: "Bearer ci-secret-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env as never);

  assert.equal((await send({ step: "install", label: "Installing", status: "running" })).status, 200);
  const failed = await send({ step: "render", label: "Rendering", status: "failed", message: "boom" });
  assert.equal(((await failed.json()) as { status: string }).status, "failed");
  const row = db.table("site_builds").find((r) => (r as { buildId?: string }).buildId === "build_test_1") as
    { status: string; verificationError: string; failedStep: string };
  assert.equal(row.status, "failed");
  assert.equal(row.verificationError, "boom");
  assert.equal(row.failedStep, "render");
  const late = await send({ step: "deploy", status: "running" });
  assert.equal(((await late.json()) as { ignored?: boolean }).ignored, true);
});

test("the CI routes refuse a missing, wrong or placeholder secret", async () => {
  const app = makeApp(new FakeDatabase());
  for (const auth of [undefined, "Bearer nope"]) {
    const res = await app.fetch(new Request("https://localhost/ci/snapshots", { headers: auth ? { Authorization: auth } : {} }), env as never);
    assert.equal(res.status, 401);
  }
  const res = await app.fetch(
    new Request("https://localhost/ci/snapshots", { headers: { Authorization: "Bearer change-me" } }),
    { ...env, DEPLOY_TRIGGER_SECRET: "change-me" } as never,
  );
  assert.equal(res.status, 401);
});
