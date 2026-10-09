import { Hono } from "hono";
import { registerDbDriver } from "../src/db";
import { FakeDatabase, fakeDriver } from "../src/testSupport/fakeDb";
import { visitorAnalyticsRoute } from "../src/routes/visitorAnalytics";
import { visitorDays } from "../src/schema";
import type { Env } from "../src/env";

console.log("visitorDays.name =", (visitorDays as { name?: string }).name);

const database = new FakeDatabase();
registerDbDriver(fakeDriver(database));

const entries = new Map<string, string>();
const kv = {
  async get(key: string) { console.log("kv.get", key); return entries.get(key) ?? null; },
  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    entries.set(key, value);
    console.log("kv.put ttl=", options?.expirationTtl);
  },
};

const env = {
  DATABASE_URL: "fake://visitor-analytics",
  ENVIRONMENT: "sandbox",
  ANALYTICS_IP_HMAC_SECRET: "visitor-analytics-test-key-0123456789abcdef",
  ANALYTICS_IP_HMAC_VERSION: "1",
  ANALYTICS_WARMUP_ENABLED: "false",
  RATE_LIMIT_KV: kv,
} as unknown as Env;

const app = new Hono<{ Bindings: Env }>();
app.route("/", visitorAnalyticsRoute);

const res = await app.fetch(
  new Request("http://localhost/analytics/visit", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.70" },
    body: '{"kind":"visit"}',
  }),
  env,
);
console.log("status =", res.status);
console.log("visitor_days =", JSON.stringify(database.rows("visitor_days")));
console.log("empty-key rows =", JSON.stringify(database.rows("")));
