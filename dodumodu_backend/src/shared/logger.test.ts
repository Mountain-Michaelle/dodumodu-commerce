// The server-side fault logger: structured, scrubbed, never throws, nothing flows to a client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { logError, swallow, swallowNull, scrub } from "./logger";

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { fn(); } finally { console.error = orig; }
  return lines;
}

test("logError writes ONE structured JSON line with event, error name/message and flat fields", () => {
  const lines = capture(() => logError("thing_failed", new TypeError("boom"), { slug: "a", n: 3, ok: false }));
  assert.equal(lines.length, 1);
  const o = JSON.parse(lines[0]);
  assert.equal(o.level, "error");
  assert.equal(o.event, "thing_failed");
  assert.equal(o.error.name, "TypeError");
  assert.equal(o.error.message, "boom");
  assert.deepEqual([o.slug, o.n, o.ok], ["a", 3, false]);
});

test("secrets and personal data are scrubbed from messages and fields", () => {
  const nasty = [
    "connect failed postgresql://neondb_owner:hunter2@ep-x.neon.tech/db?sslmode=require",
    "Authorization: Bearer abc.DEF-123_xyz",
    "key re_AbCdEf123456789",
    "sent to someone@example.com",
    "token " + "a".repeat(64),
    "id " + "9".repeat(40),
  ].join(" | ");
  const lines = capture(() => logError("x", new Error(nasty), { who: "someone@example.com" }));
  const text = lines[0];
  for (const bad of ["hunter2", "neondb_owner", "abc.DEF-123_xyz", "re_AbCdEf123456789", "someone@example.com", "a".repeat(64), "9".repeat(40)]) {
    assert.ok(!text.includes(bad), `leaked: ${bad}`);
  }
  assert.ok(text.includes("[redacted]") || text.includes("[email]"));
});

test("long messages are capped", () => {
  assert.ok(scrub("x ".repeat(1000)).length <= 401);
});

test("logError never throws, even when console.error or the value is hostile", () => {
  const orig = console.error;
  console.error = () => { throw new Error("console is broken"); };
  try {
    assert.doesNotThrow(() => logError("x", new Error("e")));
  } finally { console.error = orig; }
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.doesNotThrow(() => logError("x", circular));
  assert.doesNotThrow(() => logError("x", undefined));
});

test("swallow logs the failure and resolves the chain; swallowNull also yields null", async () => {
  const lines = capture(() => { /* sync capture only */ });
  void lines;
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  try {
    const a = await Promise.reject(new Error("db down")).catch(swallow("write_failed", { k: "v" }));
    const b = await Promise.reject(new Error("bad key")).catch(swallowNull("decrypt_failed"));
    assert.equal(a, undefined);
    assert.equal(b, null);
  } finally { console.error = orig; }
  assert.equal(seen.length, 2);
  assert.match(seen[0], /write_failed/);
  assert.match(seen[0], /db down/);
  assert.match(seen[1], /decrypt_failed/);
});
