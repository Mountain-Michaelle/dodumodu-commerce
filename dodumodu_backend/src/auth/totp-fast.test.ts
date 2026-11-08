import { test } from "node:test";
import assert from "node:assert/strict";
import { hotp, newTotpSecret } from "./crypto";
import { totpMatchFast } from "./totp-fast";

const NOW = 1_800_000_000_000;
const step = Math.floor(NOW / 30000);

test("accepts the current step and ±2, rejects ±3", async () => {
  const s = newTotpSecret();
  for (const d of [-2, -1, 0, 1, 2]) {
    assert.equal(await totpMatchFast(s, await hotp(s, step + d), NOW), step + d);
  }
  for (const d of [-3, 3]) {
    assert.equal(await totpMatchFast(s, await hotp(s, step + d), NOW), null);
  }
});

test("rejects empty, short, long and non-digit input", async () => {
  const s = newTotpSecret();
  const good = await hotp(s, step);
  for (const bad of ["", "12345", good + "0", "abcdef", good.slice(0, 5) + "x", " " + good]) {
    assert.equal(await totpMatchFast(s, bad, NOW), null);
  }
});

test("codes with leading zeros match", async () => {
  const s = newTotpSecret();
  let c = step;
  let code = await hotp(s, c);
  while (!code.startsWith("0")) { c++; code = await hotp(s, c); }
  assert.equal(await totpMatchFast(s, code, (c + 0.5) * 30000), c);
});

test("agrees with hotp() on 20 random secrets", async () => {
  for (let i = 0; i < 20; i++) {
    const s = newTotpSecret();
    assert.equal(await totpMatchFast(s, await hotp(s, step), NOW), step);
  }
});

test("5-step check is fast (< 50 ms)", async () => {
  const s = newTotpSecret();
  const code = await hotp(s, step + 2);
  const t0 = performance.now();
  await totpMatchFast(s, code, NOW);
  assert.ok(performance.now() - t0 < 50);
});