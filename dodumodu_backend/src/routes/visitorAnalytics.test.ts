import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { registerDbDriver, type DbDriver } from "../db";
import { visitorAnalyticsRoute } from "./visitorAnalytics";
import { FakeDatabase, fakeDriver, type Row } from "../testSupport/fakeDb";
import type { Env } from "../env";

const baseEnv = {
  DATABASE_URL: "fake://visitor-analytics",
  ENVIRONMENT: "sandbox",
  ANALYTICS_IP_HMAC_SECRET: "visitor-analytics-test-key-0123456789abcdef",
  ANALYTICS_IP_HMAC_VERSION: "1",
  ANALYTICS_WARMUP_ENABLED: "false",
} as unknown as Env;

function makeApp(env = baseEnv) {
  const database = new FakeDatabase();
  registerDbDriver(fakeDriver(database));
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", visitorAnalyticsRoute);
  return { app, database, env };
}

function request(
  body: string,
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost/analytics/visit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.70",
      ...headers,
    },
    body,
  });
}

function memoryKV() {
  const entries = new Map<string, string>();
  const writes: { key: string; value: string; ttl?: number }[] = [];
  const kv = {
    entries,
    writes,
    async get(key: string) { return entries.get(key) ?? null; },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      entries.set(key, value);
      writes.push({ key, value, ttl: options?.expirationTtl });
    },
  };
  return kv as unknown as KVNamespace & typeof kv;
}

function withKv(env: Env, kv: KVNamespace): Env {
  return { ...env, RATE_LIMIT_KV: kv } as Env;
}

test("public visit writes one HMAC visitor-day and contains no raw IP", async () => {
  const { app, database, env } = makeApp();
  const kv = memoryKV();
  const response = await app.fetch(request('{"kind":"visit"}'), withKv(env, kv));
  assert.equal(response.status, 204);
  const rows = database.rows("visitor_days");
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes("203.0.113.70"), false);
  assert.equal(kv.writes[0].ttl, 60);
  assert.equal(kv.writes[0].key.includes("203.0.113.70"), false);
});

test("duplicate visit requests are throttled without another database write", async () => {
  const { app, database, env } = makeApp();
  const kv = memoryKV();
  const configured = withKv(env, kv);
  const one = await app.fetch(request('{"kind":"visit"}'), configured);
  const two = await app.fetch(request('{"kind":"visit"}'), configured);
  assert.equal(one.status, 204);
  assert.equal(two.status, 204);
  assert.equal(database.rows("visitor_days").length, 1);
});

test("invalid, extra-field, and malformed events are rejected before any write", async () => {
  const { app, database, env } = makeApp();
  const kv = memoryKV();
  for (const body of [
    '{"kind":"purchase"}',
    '{"kind":"visit","phone":"08012345678"}',
    '{',
  ]) {
    const response = await app.fetch(request(body), withKv(env, kv));
    assert.equal(response.status, 400);
  }
  assert.equal(database.rows("visitor_days").length, 0);
  assert.equal(kv.writes.length, 0);
});

test("intent is disabled by default and warm-up sends no client state", async () => {
  const { app, database, env } = makeApp();
  const kv = memoryKV();
  const response = await app.fetch(request('{"kind":"intent"}'), withKv(env, kv));
  assert.equal(response.status, 204);
  assert.equal(database.rows("visitor_days").length, 0);
  assert.equal(kv.writes.length, 0);
});

test("enabled intent performs one anonymous warm-up and is throttled server-side", async () => {
  const { app, database, env } = makeApp({
    ...baseEnv,
    ANALYTICS_WARMUP_ENABLED: "true",
  } as Env);
  const kv = memoryKV();
  const configured = withKv(env, kv);
  const response = await app.fetch(request('{"kind":"intent"}'), configured);
  assert.equal(response.status, 204);
  assert.equal(database.rows("visitor_days").length, 0);
  assert.equal(kv.writes.length, 1);
  assert.equal(kv.writes[0].ttl, 60);
});

test("missing IP fails open without database writes", async () => {
  const { app, database, env } = makeApp();
  const response = await app.fetch(request('{"kind":"visit"}', { "cf-connecting-ip": "" }), withKv(env, memoryKV()));
  assert.equal(response.status, 204);
  assert.equal(database.rows("visitor_days").length, 0);
});

test("analytics database failures return an explicit error without a success-shaped response", async () => {
  const database = new FakeDatabase();
  const failingDriver: DbDriver = () => {
    const db = {
      select: () => ({ then: (resolve: (rows: Row[]) => unknown) => Promise.resolve(resolve([])) }),
      insert: () => { throw new Error("database unavailable"); },
    };
    return db as never;
  };
  registerDbDriver(failingDriver);
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", visitorAnalyticsRoute);
  const kv = memoryKV();
  const response = await app.fetch(request('{"kind":"visit"}'), withKv(baseEnv, kv));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: { code: "ANALYTICS_UNAVAILABLE", message: "Visitor analytics is temporarily unavailable." },
  });
});
