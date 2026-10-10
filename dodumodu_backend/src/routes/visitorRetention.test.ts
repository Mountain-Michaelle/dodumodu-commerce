import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { registerDbDriver } from "../db";
import { FakeDatabase, fakeDriver } from "../testSupport/fakeDb";
import { visitorAnalyticsService } from "../services/visitorAnalyticsService";
import { visitorRetentionRoute } from "./visitorRetention";
import type { Env } from "../env";

const db = new FakeDatabase();
registerDbDriver(fakeDriver(db));
const app = new Hono<{ Bindings: Env }>();
app.route("/", visitorRetentionRoute);
const env = {
  DATABASE_URL: "fake://visitor-retention-test",
  RECONCILE_CRON_SECRET: "test-secret",
  ENVIRONMENT: "sandbox",
} as unknown as Env;

test("visitor retention prune rejects missing and incorrect cron secrets", async () => {
  const missing = await app.fetch(
    new Request("http://localhost/internal/visitor-retention/prune", { method: "POST" }),
    env as never,
  );
  const incorrect = await app.fetch(
    new Request("http://localhost/internal/visitor-retention/prune", {
      method: "POST",
      headers: { "x-cron-secret": "wrong" },
    }),
    env as never,
  );
  assert.equal(missing.status, 401);
  assert.equal(incorrect.status, 401);
});

test("visitor retention prune uses the shared cron secret and reports the bounded batch", async () => {
  const original = visitorAnalyticsService.pruneExpired;
  let calls = 0;
  visitorAnalyticsService.pruneExpired = async () => {
    calls += 1;
    return { cutoff: "2027-03-10", deleted: 500, morePending: true };
  };
  try {
    const response = await app.fetch(
      new Request("http://localhost/internal/visitor-retention/prune", {
        method: "POST",
        headers: { "x-cron-secret": "test-secret" },
      }),
      env as never,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      cutoff: "2027-03-10",
      deleted: 500,
      morePending: true,
    });
    assert.equal(calls, 1);
  } finally {
    visitorAnalyticsService.pruneExpired = original;
  }
});
