import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyticsHashVersion,
  hashVisitorIp,
  lagosDate,
  retentionCutoffDate,
  visitorGeo,
} from "./visitorAnalyticsService";

const SECRET = "visitor-analytics-test-key-0123456789abcdef";

test("visitor IP hashes are stable HMAC values and differ by IP and key", async () => {
  const first = await hashVisitorIp("203.0.113.10", SECRET);
  assert.equal(first, await hashVisitorIp("203.0.113.10", SECRET));
  assert.notEqual(first, await hashVisitorIp("203.0.113.11", SECRET));
  assert.notEqual(first, await hashVisitorIp("203.0.113.10", `${SECRET}-rotated`));
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("visitor hashing rejects missing or weak secrets and malformed client addresses", async () => {
  await assert.rejects(hashVisitorIp("203.0.113.10", ""), /at least 32 bytes/);
  await assert.rejects(hashVisitorIp("203.0.113.10", "too-short"), /at least 32 bytes/);
  await assert.rejects(hashVisitorIp("", SECRET), /not valid/);
  await assert.rejects(hashVisitorIp("203.0.113.10\r\nforged", SECRET), /not valid/);
  await assert.rejects(hashVisitorIp("x".repeat(65), SECRET), /not valid/);
});

test("visitor hash versions must fit the PostgreSQL smallint field", () => {
  assert.equal(analyticsHashVersion(undefined), 1);
  assert.equal(analyticsHashVersion("12"), 12);
  for (const value of ["0", "-1", "32768", "1.5", "NaN"]) {
    assert.throws(() => analyticsHashVersion(value), /integer from 1 to 32767/);
  }
});

test("Cloudflare visitor geography is normalized and remains approximate", () => {
  assert.deepEqual(visitorGeo("ng", "Lagos"), { country: "NG", region: "Lagos" });
  assert.deepEqual(visitorGeo("T1", undefined), { country: "T1", region: null });
  assert.deepEqual(visitorGeo("NGA", "x".repeat(81)), { country: null, region: null });
  assert.deepEqual(visitorGeo(undefined, "Lagos\nforged"), { country: null, region: null });
});

test("Lagos dates and the 13-month retention cutoff are timezone-independent", () => {
  assert.equal(lagosDate(new Date("2026-10-08T22:59:59.000Z")), "2026-10-08");
  assert.equal(lagosDate(new Date("2026-10-08T23:00:00.000Z")), "2026-10-09");
  assert.equal(retentionCutoffDate("2026-10-08"), "2025-09-08");
  assert.equal(retentionCutoffDate("2028-03-31"), "2027-02-28");
});
