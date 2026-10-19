// Committed coverage for IP normalization + encrypted-IP storage (spec §4.13).
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIp, blockPrefix, clientIp, parseTrustedProxy, ipHash } from "./ip.js";
import { encryptIp, decryptIp } from "./ipCrypto.js";
import { loadKey } from "./crypto.js";

const K1 = loadKey(Buffer.alloc(32, 1).toString("base64"));
const K2 = loadKey(Buffer.alloc(32, 2).toString("base64"));

test("normalizeIp maps IPv4-mapped IPv6 to IPv4 and pads IPv6", () => {
  assert.equal(normalizeIp("1.2.3.4"), "1.2.3.4");
  assert.equal(normalizeIp("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(normalizeIp("2001:DB8::1"), "2001:0db8:0000:0000:0000:0000:0000:0001");
});

test("normalizeIp rejects garbage and out-of-range octets", () => {
  assert.equal(normalizeIp(""), null);
  assert.equal(normalizeIp("1.2.3.999"), null);
  assert.equal(normalizeIp("1.2.3"), null);
  assert.equal(normalizeIp("gggg::1"), null);
  assert.equal(normalizeIp("1::2::3"), null);
});

test("blockPrefix is /32 for IPv4 and /64 for IPv6", () => {
  assert.equal(blockPrefix("1.2.3.4"), "1.2.3.4");
  assert.equal(blockPrefix("2001:db8:1:2:3:4:5:6"), "2001:0db8:0001:0002");
  assert.equal(blockPrefix("nope"), null);
});

test("clientIp honours each TRUSTED_PROXY mode", () => {
  const h = (map: Record<string, string>) => ({ get: (n: string) => map[n.toLowerCase()] ?? null });
  assert.equal(clientIp("cloudflare", h({ "cf-connecting-ip": "9.9.9.9" }), "0.0.0.0"), "9.9.9.9");
  assert.equal(clientIp("none", h({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "8.8.8.8" }), "1.1.1.1"), "1.1.1.1");
  assert.equal(clientIp({ hops: 1 }, h({ "x-forwarded-for": "8.8.8.8, 9.9.9.9" })), "9.9.9.9"); // right-most hop
  assert.equal(clientIp("cloudflare", h({}), "2.2.2.2"), "2.2.2.2"); // no header -> socket
});

test("parseTrustedProxy defaults unknown to none (fail safe)", () => {
  assert.deepEqual(parseTrustedProxy("cloudflare"), "cloudflare");
  assert.deepEqual(parseTrustedProxy("hops:2"), { hops: 2 });
  assert.deepEqual(parseTrustedProxy("garbage"), "none");
  assert.deepEqual(parseTrustedProxy(undefined), "none");
});

test("ipHash is deterministic and domain-separated from the email HMAC", async () => {
  const a = await ipHash(K1, "1.2.3.4");
  const b = await ipHash(K1, "1.2.3.4");
  const c = await ipHash(K1, "1.2.3.5");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("encryptIp/decryptIp round-trips; wrong key + tamper fail closed; rotation reads old kid", async () => {
  const ring1 = { k1: K1 };
  const blob = await encryptIp(ring1, "k1", "203.0.113.9");
  assert.ok(blob.startsWith("v1:k1:"));
  assert.equal(await decryptIp(ring1, blob), "203.0.113.9");
  // Wrong key only -> null (fail closed).
  assert.equal(await decryptIp({ kX: K2 }, blob), null);
  // Tampered ciphertext -> null.
  const [p0, p1, p2, p3] = blob.split(":");
  const flipped = p3.startsWith("A") ? `B${p3.slice(1)}` : `A${p3.slice(1)}`;
  assert.equal(await decryptIp(ring1, [p0, p1, p2, flipped].join(":")), null);
  // Rotation: add k2, old rows (k1) still decrypt with a ring that has both.
  const ring2 = { k1: K1, k2: K2 };
  assert.equal(await decryptIp(ring2, blob), "203.0.113.9");
});
