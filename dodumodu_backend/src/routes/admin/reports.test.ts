import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { adminRoute } from "../admin";
import { registerDbDriver } from "../../db";
import { FakeDatabase, fakeDriver } from "../../testSupport/fakeDb";
import { monthlyKpiService } from "../../services/monthlyKpiService";
import { ACCESS_EMAIL_HEADER } from "../../auth/adminAuth";
import type { Env } from "../../env";

const env = {
  DATABASE_URL: "fake://monthly-kpi-test",
  ADMIN_OPERATORS: "",
  ENVIRONMENT: "sandbox",
} as unknown as Env;

const db = new FakeDatabase();
registerDbDriver(fakeDriver(db));

const app = new Hono<{ Bindings: Env }>();
app.route("/admin", adminRoute);

let calls: { months: number; actor: string }[] = [];
const originalReport = monthlyKpiService.report;

beforeEach(() => {
  calls = [];
  monthlyKpiService.report = async (_db, months, _now, actor) => {
    calls.push({ months, actor: actor ?? "" });
    return [];
  };
});

afterEach(() => {
  monthlyKpiService.report = originalReport;
});

test("monthly KPI report requires an authenticated operator", async () => {
  const response = await app.fetch(
    new Request("http://localhost/admin/reports/monthly-kpis"),
    env as never,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test("monthly KPI report refuses authenticated identities outside the allowlist", async () => {
  const response = await app.fetch(
    new Request("http://localhost/admin/reports/monthly-kpis", {
      headers: { [ACCESS_EMAIL_HEADER]: "stranger@example.com" },
    }),
    { ...env, ADMIN_OPERATORS: "owner@example.com" } as unknown as Env as never,
  );
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
});

test("monthly KPI report rejects invalid month windows without querying the service", async () => {
  for (const months of ["0", "25", "1.5", "abc"]) {
    const response = await app.fetch(
      new Request(`http://localhost/admin/reports/monthly-kpis?months=${months}`, {
        headers: { [ACCESS_EMAIL_HEADER]: "owner@example.com" },
      }),
      env as never,
    );
    assert.equal(response.status, 400, `months=${months}`);
  }
  assert.deepEqual(calls, []);
});

test("monthly KPI report uses orders:read authorization and passes the bounded window", async () => {
  const response = await app.fetch(
    new Request("http://localhost/admin/reports/monthly-kpis?months=2", {
      headers: { [ACCESS_EMAIL_HEADER]: "owner@example.com" },
    }),
    env as never,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    reports: unknown[];
    collectionAvailable: boolean;
    collectionUnavailableReason: string;
  };
  assert.deepEqual(body.reports, []);
  assert.equal(body.collectionAvailable, false);
  assert.match(body.collectionUnavailableReason, /authoritative collection record/);
  assert.deepEqual(calls, [{ months: 2, actor: "owner@example.com" }]);
});

test("monthly KPI report maps service failures to the shared internal error response", async () => {
  const original = monthlyKpiService.report;
  monthlyKpiService.report = async () => { throw new Error("database details"); };
  try {
    const response = await app.fetch(
      new Request("http://localhost/admin/reports/monthly-kpis", {
        headers: { [ACCESS_EMAIL_HEADER]: "owner@example.com" },
      }),
      env as never,
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side. Nothing was changed." },
    });
  } finally {
    monthlyKpiService.report = original;
  }
});
