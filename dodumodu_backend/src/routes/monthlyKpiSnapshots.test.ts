import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { registerDbDriver } from "../db";
import { FakeDatabase, fakeDriver } from "../testSupport/fakeDb";
import { monthlyKpiService } from "../services/monthlyKpiService";
import { monthlyKpiSnapshotsRoute } from "./monthlyKpiSnapshots";
import type { Env } from "../env";

const db = new FakeDatabase();
registerDbDriver(fakeDriver(db));
const app = new Hono<{ Bindings: Env }>();
app.route("/", monthlyKpiSnapshotsRoute);
const env = {
  DATABASE_URL: "fake://monthly-kpi-close-test",
  RECONCILE_CRON_SECRET: "test-secret",
  ENVIRONMENT: "sandbox",
} as unknown as Env;

test("monthly snapshot close rejects missing and incorrect cron secrets", async () => {
  const missing = await app.fetch(
    new Request("http://localhost/internal/monthly-kpi-snapshots/close", { method: "POST" }),
    env as never,
  );
  const incorrect = await app.fetch(
    new Request("http://localhost/internal/monthly-kpi-snapshots/close", {
      method: "POST",
      headers: { "x-cron-secret": "wrong" },
    }),
    env as never,
  );
  assert.equal(missing.status, 401);
  assert.equal(incorrect.status, 401);
});

test("monthly snapshot close uses the existing cron secret and returns the captured month", async () => {
  const original = monthlyKpiService.closePreviousMonth;
  let calls = 0;
  monthlyKpiService.closePreviousMonth = async () => {
    calls += 1;
    return { month: "2026-09", source: "close", takenAt: new Date("2026-10-01T00:00:00Z") } as never;
  };
  try {
    const response = await app.fetch(
      new Request("http://localhost/internal/monthly-kpi-snapshots/close", {
        method: "POST",
        headers: { "x-cron-secret": "test-secret" },
      }),
      env as never,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      month: "2026-09",
      source: "close",
      takenAt: "2026-10-01T00:00:00.000Z",
    });
    assert.equal(calls, 1);
  } finally {
    monthlyKpiService.closePreviousMonth = original;
  }
});
