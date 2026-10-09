
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toB64, fromB64, loadKey, normalizeEmail, maskEmail, emailHmac, deriveCode, codeMac,
  sha256, safeEqual, encryptSecret, decryptSecret, b64u, newTotpSecret, b32decode, hotp, totpMatch,
} from "./crypto";
import { hashPhrase, verifyPhrase, verifyDummyPhrase } from "./argon2";

// base64 round-trip over every byte value
test("toB64/fromB64 round-trips every byte value", () => {
  for (let b = 0; b < 256; b++) {
    const u8 = new Uint8Array(3);
    u8[0] = b;
    u8[1] = b ^ 0xff;
    u8[2] = (b + 7) & 0xff;
    assert.equal(fromB64(toB64(u8))[0], b);
    assert.equal(fromB64(toB64(u8))[1], b ^ 0xff);
    assert.equal(fromB64(toB64(u8))[2], (b + 7) & 0xff);
  }
});

test("b64u is base64url compact (no +, /, =)", () => {
  const u8 = new Uint8Array([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
  const s = b64u(u8);
  assert.ok(!s.includes("+") && !s.includes("/") && !s.includes("="));
  assert.equal(toB64(u8), s.replace(/-/g,"+").replace(/_/g,"/") + "==");
});

test("fromB64 handles standard base64 with + and /", () => {
  assert.deepEqual(fromB64("AQIDBAUGBwgJCgsMDQ4PEA=="), new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]));
});

// A valid 32-byte key (base64 of 32 bytes of 0x07). Used for every keyed test below.
const KEY32 = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

test("loadKey accepts exactly 32-byte standard base64", () => {
  const k = loadKey(KEY32, "otp");
  assert.equal(k.length, 32);
});

test("loadKey rejects wrong lengths", () => {
  assert.throws(() => loadKey("A".repeat(40)), /must be 32 bytes/); // 30 bytes
  assert.throws(() => loadKey("A".repeat(42)), /must be 32 bytes/); // 31 bytes
  assert.throws(() => loadKey("A".repeat(44)), /must be 32 bytes/); // 33 bytes
});


test("normalizeEmail", () => {
  assert.equal(normalizeEmail("  Owner@Example.COM  "), "owner@example.com");
  assert.equal(normalizeEmail("  "), null);
  assert.equal(normalizeEmail("owner@example"), null);
  assert.equal(normalizeEmail("owner@@example.com"), null);
  assert.equal(normalizeEmail("o@example.com"), "o@example.com");
  assert.equal(normalizeEmail("owner@example.com\n"), "owner@example.com");
});

test("maskEmail", () => {
  assert.equal(maskEmail("owner@example.com"), "o***@e***");
});

test("emailHmac is deterministic and base64url", async () => {
  const k = loadKey(KEY32, "throttle");
  const a = await emailHmac(k, "owner@example.com");
  const b = await emailHmac(k, "owner@example.com");
  assert.equal(a, b); // same normalized input -> same mac
  // emailHmac does NOT normalize; case-insensitivity is the caller's job
  // (normalizeEmail). Feeding it a normalized value must match the lowercase form.
  const c = await emailHmac(k, normalizeEmail("  Owner@Example.COM  ")!);
  assert.equal(a, c);
  assert.ok(!a.includes("+") && !a.includes("/") && !a.includes("="));
});

test("deriveCode is deterministic, opaque, and one of the allowed chars", async () => {
  const otpKey = loadKey(KEY32, "otp");
  const code1 = await deriveCode(otpKey, "user:1", new Uint8Array([1,2,3]));
  const code2 = await deriveCode(otpKey, "user:1", new Uint8Array([1,2,3]));
  assert.equal(code1, code2);
  assert.equal(code1.length, 10);
  assert.ok(/^[0-9A-F!#$%&*+?]+$/.test(code1));
});

test("deriveCode changes with the nonce", async () => {
  const otpKey = loadKey(KEY32, "otp");
  assert.notEqual(
    await deriveCode(otpKey, "user:1", new Uint8Array([1,2,3])),
    await deriveCode(otpKey, "user:1", new Uint8Array([1,2,4]))
  );
});

test("codeMac is deterministic and keyed", async () => {
  const otpKey = loadKey(KEY32, "otp");
  const a = await codeMac(otpKey, "user:1", "AAAAAAAAAA");
  const b = await codeMac(otpKey, "user:1", "AAAAAAAAAA");
  const c = await codeMac(otpKey, "user:2", "AAAAAAAAAA");
  assert.deepEqual(a, b); // deterministic -> equal bytes
  assert.notDeepEqual(a, c); // keyed by user id -> different bytes
});


test("sha256", async () => {
  const a = await sha256("hello");
  const b = await sha256("hello");
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);
});

test("safeEqual", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

test("encryptSecret/decryptSecret round-trip", async () => {
  const key = loadKey(KEY32, "totp-enc");
  const plain = JSON.stringify({ sub: "user:1", key32: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" });
  const enc = await encryptSecret(key, plain);
  const dec = await decryptSecret(key, enc);
  assert.equal(dec, plain);
});

test("newTotpSecret produces 32-char base32", () => {
  const s = newTotpSecret();
  assert.equal(s.length, 32);
  assert.ok(/^[A-Z2-7]+$/.test(s));
});

test("b32decode of newTotpSecret round-trips", () => {
  const s = newTotpSecret();
  const dec = b32decode(s);
  assert.ok(dec.length >= 10);
  let bits = "";
  for (const b of dec) bits += b.toString(2).padStart(8, "0");
  let s2 = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    s2 += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[parseInt(bits.slice(i, i + 5), 2)];
  }
  assert.equal(s2.slice(0, 32), s);
});


test("RFC 6238 vectors (SHA-1, 8 digits)", async () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const vec = [
    [1, "94287082"],
    [37037036, "07081804"],
    [37037037, "14050471"],
    [41152263, "89005924"],
    [66666666, "69279037"],
    [666666666, "65353130"],
  ];
  for (const [counter, expected] of vec) {
    const g = await hotp(secret, counter, 8);
    assert.equal(g, expected, "counter=" + counter);
  }
});

test("totpMatch accepts the 6-digit step and the window around it", async () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const step = Math.floor(Date.now() / 30000);
  const code = await hotp(secret, step, 6);
  assert.equal(await totpMatch(secret, code), step);
  assert.equal(await totpMatch(secret, await hotp(secret, step - 1, 6)), step - 1);
  assert.equal(await totpMatch(secret, "000000"), null);
});

test("hashPhrase / verifyPhrase round-trip", async () => {
  const phrase = "perfection-july-sunset-7";
  const h = await hashPhrase(phrase);
  assert.ok(h.startsWith("$argon2id$v=19$"));
  assert.equal(await verifyPhrase(h, phrase), true);
  assert.equal(await verifyPhrase(h, "wrong-phrase"), false);
});

test("verifyPhrase rejects a truncated stored hash", async () => {
  const h = await hashPhrase("perfection-july-sunset-7");
  assert.equal(await verifyPhrase(h.slice(0, h.length - 4), "perfection-july-sunset-7"), false);
});

test("verifyDummyPhrase", async () => {
  assert.equal(await verifyDummyPhrase("dummy-phrase-for-timing-only"), true);
  assert.equal(await verifyDummyPhrase("wrong"), false);
});

