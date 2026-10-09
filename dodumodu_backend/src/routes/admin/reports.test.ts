import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { adminRoute } from "../admin";
import { registerDbDriver } from "../../db";
import { FakeDatabase, fakeDriver } from "../../testSupport/fakeDb";
import { monthlyKpiService } from "../../services/monthlyKpiService";
import { visitorAnalyticsService } from "../../services/visitorAnalyticsService";
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

const originalVisitorReport = visitorAnalyticsService.report;

afterEach(() => {
  visitorAnalyticsService.report = originalVisitorReport;
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

test("visitor report requires an authenticated operator and exposes distinct visitor data", async () => {
  visitorAnalyticsService.report = async () => ({
    trackingStartedOn: "2026-10-01",
    daily: [{ date: "2026-10-01", visitors: 3 }],
    monthly: [{ month: "2026-10", visitors: 5 }],
    yearly: [{ year: 2026, visitors: 5, complete: false, current: true }],
    geographyApproximate: true,
    geography: [],
  }) as never;

  const unauthorized = await app.fetch(
    new Request("http://localhost/admin/reports/visitors"),
    env as never,
  );
  assert.equal(unauthorized.status, 401);

  const response = await app.fetch(
    new Request("http://localhost/admin/reports/visitors", {
      headers: { [ACCESS_EMAIL_HEADER]: "owner@example.com" },
    }),
    env as never,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    daily: { date: string; visitors: number }[];
    monthly: { month: string; visitors: number }[];
    yearly: { year: number; visitors: number }[];
    geographyApproximate: boolean;
    notice: string;
  };
  assert.deepEqual(body.daily, [{ date: "2026-10-01", visitors: 3 }]);
  assert.deepEqual(body.monthly, [{ month: "2026-10", visitors: 5 }]);
  assert.equal(body.yearly[0].visitors, 5);
  assert.equal(body.geographyApproximate, true);
  assert.match(body.notice, /not additive/i);
  // Raw IPs are never surfaced by the report.
  assert.ok(!JSON.stringify(body).match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/));
});

test("visitor report validates the daily from/to window before querying the service", async () => {
  let seenRanges: ({ from: string; to: string } | null)[] = [];
  visitorAnalyticsService.report = async (_db, _now, range = null) => {
    seenRanges.push(range);
    return {
      trackingStartedOn: "2026-10-01",
      today: "2026-10-09",
      dailyRange: { from: "2026-09-30", to: "2026-10-08" },
      daily: [],
      monthly: [],
      yearly: [],
      geographyApproximate: true,
      geography: [],
    } as never;
  };

  // Missing partner, malformed dates, inverted ranges and over-long spans are all
  // rejected before the service ever runs — this is what keeps the daily series
  // (the paged part of the report) bounded to at most 93 Lagos days.
  const invalid = [
    "from=2026-10-01",
    "to=2026-10-09",
    "from=01-10-2026&to=2026-10-09",
    "from=2026-10-09&to=2026-10-01",
    "from=2026-01-01&to=2026-06-01",
  ];
  for (const query of invalid) {
    const response = await app.fetch(
      new Request(`http://localhost/admin/reports/visitors?${query}`, {
        headers: { [ACCESS_EMAIL_HEADER]: "owner@example.com" },
      }),
      env as never,
    );
    assert.equal(response.status, 400, query);
  }
  assert.deepEqual(seenRanges, []);

  // A valid 10-day paging window reaches the service verbatim, and the echoed
  // dailyRange/today are what the UI's Prev/Next controls page against.
  const response = await app.fetch(
    new Request("http://localhost/admin/reports/visitors?from=2026-09-30&to=2026-10-08", {
      headers: { [ACCESS_EMAIL_HEADER]: "owner@example.com" },
    }),
    env as never,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(seenRanges, [{ from: "2026-09-30", to: "2026-10-08" }]);
  const body = await response.json() as { dailyRange: { from: string; to: string }; today: string };
  assert.deepEqual(body.dailyRange, { from: "2026-09-30", to: "2026-10-08" });
  assert.equal(body.today, "2026-10-09");
});

test("visitor report maps service failures to the shared internal error response", async () => {
  visitorAnalyticsService.report = async () => { throw new Error("database details"); };
  const response = await app.fetch(
    new Request("http://localhost/admin/reports/visitors", {
      headers: { [ACCESS_EMAIL_HEADER]: "owner@example.com" },
    }),
    env as never,
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side. Nothing was changed." },
  });
});
