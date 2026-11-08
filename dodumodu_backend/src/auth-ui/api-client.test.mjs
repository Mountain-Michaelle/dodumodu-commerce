import { test } from "node:test";
import assert from "node:assert/strict";
import { api, normalizeTotpInput } from "./api-client.mjs";

const noSleep = async () => {};
const ok = (status, data) => ({ status, json: async () => data });

test("normalizeTotpInput strips spaces/dashes/letters and caps at 6", () => {
  assert.equal(normalizeTotpInput("123 456"), "123456");
  assert.equal(normalizeTotpInput("12-34-56-78"), "123456");
  assert.equal(normalizeTotpInput(null), "");
});

test("retries network failures then succeeds", async () => {
  let n = 0;
  const fetchImpl = async () => { if (++n < 3) throw new Error("net"); return ok(200, { next: "ready" }); };
  const r = await api("/x", {}, { retries: 2, fetchImpl, sleepImpl: noSleep });
  assert.equal(r.status, 200);
  assert.equal(n, 3);
});

test("retries 503 but never 401", async () => {
  let n = 0;
  const f503 = async () => (++n < 2 ? ok(503, {}) : ok(200, { next: "ready" }));
  assert.equal((await api("/x", {}, { retries: 2, fetchImpl: f503, sleepImpl: noSleep })).status, 200);
  n = 0;
  const f401 = async () => { n++; return ok(401, { error: "Invalid or expired code" }); };
  assert.equal((await api("/x", {}, { retries: 2, fetchImpl: f401, sleepImpl: noSleep })).status, 401);
  assert.equal(n, 1);
});

test("no retries by default and a hung request times out", async () => {
  let n = 0;
  const hang = (_u, { signal }) => new Promise((_, rej) => { n++; signal.addEventListener("abort", () => rej(new Error("abort"))); });
  const r = await api("/x", {}, { timeoutMs: 20, fetchImpl: hang, sleepImpl: noSleep });
  assert.equal(r.status, 0);
  assert.equal(n, 1);
});