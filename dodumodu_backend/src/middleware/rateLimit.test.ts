import { test } from "node:test";
import assert from "node:assert/strict";
import { apiRateLimit, adminRateLimit, adminWriteRateLimit } from "./rateLimit";

/* The admin limiter is a SEPARATE budget from the customer one, and this is the
   test that keeps it that way.

   Before the split, /admin/* used apiRateLimit, which keys on `api:${ip}` - the
   same bucket as /page-data, /published and /create-order - with a 20/minute
   ceiling. Locally every request is 127.0.0.1, so the console, the customer
   endpoints and the test suite itself all drew on ONE budget of 20, and the
   console locked itself out after about seven searches. The symptom looked like a
   bug in the panel and was entirely a keying mistake.

   The properties worth pinning:
     - admin reads do not consume the customer budget, in either direction
     - admin reads have their own, far higher ceiling
     - writes are limited separately from reads
     - a 429 arrives in the standard error envelope, so the panel can render it */

/** The slice of KVNamespace the limiter uses, backed by a Map, with `store` for assertions. */
type StubKV = KVNamespace & { store: Map<string, string> };

function memoryKV(): StubKV {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
  } as unknown as StubKV;
}

/** What a limiter returns when it refuses: the response object, never undefined. */
type Refusal = { status: number; body: unknown };

/** A Context carrying only what the limiter reads. */
function ctx(kv: KVNamespace, env: Record<string, unknown>, headers: Record<string, string> = {}) {
  const values = new Map<string, string>();
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    env: { RATE_LIMIT_KV: kv, ...env },
    json: (body: unknown, status: number) => ({ body, status }),
    get: (key: string) => values.get(key),
  } as never;
}

/**
 * Runs the limiter and reports whether it REFUSED. Reading the status rather than
 * the truthiness of the return value is what makes these assertions say what they
 * mean: `undefined` means "passed through to the route", and anything else is the
 * response the operator would have been shown.
 */
async function refusedBy(limiter: (c: never, next: () => Promise<void>) => Promise<unknown>, request: () => never) {
  const result = await limiter(request(), async () => {});
  return (result ?? undefined) as Refusal | undefined;
}

const ACCESS = "cf-access-authenticated-user-email";

test("admin reads draw on their own budget and never touch the customer's", async () => {
  const kv = memoryKV();
  const env = { RATE_LIMIT_API_PER_MINUTE: "20", RATE_LIMIT_ADMIN_PER_MINUTE: "600" };
  const admin = () => ctx(kv, env, { [ACCESS]: "owner@example.com" });
  const customer = () => ctx(kv, env, { "cf-connecting-ip": "203.0.113.9" });

  // Burn the CUSTOMER budget completely. If the two shared a key this would also
  // have exhausted the admin's, which is exactly the bug.
  for (let i = 0; i < 20; i++) {
    const res = await apiRateLimit(customer(), async () => {});
    assert.equal(res, undefined, `customer request ${i + 1} should have passed`);
  }
  const blocked = await refusedBy(apiRateLimit, customer);
  assert.equal(blocked?.status, 429, "the 21st customer request must be refused");

  // The admin is unaffected: a console that shares a customer's budget is a
  // console that a customer can lock out.
  for (let i = 0; i < 40; i++) {
    const res = await adminRateLimit(admin(), async () => {});
    assert.equal(res, undefined, `admin request ${i + 1} should have passed`);
  }
  assert.equal(kv.store.has("api:203.0.113.9"), true, "the customer bucket should exist");
  assert.equal(kv.store.has("admin:read:owner@example.com"), true, "the admin bucket should exist");
});

test("writes are counted separately from reads, and writes are the tighter limit", async () => {
  const kv = memoryKV();
  const env = { RATE_LIMIT_ADMIN_PER_MINUTE: "600", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "3" };
  const asAdmin = () => ctx(kv, env, { [ACCESS]: "owner@example.com" });

  for (let i = 0; i < 3; i++) {
    const res = await adminWriteRateLimit(asAdmin(), async () => {});
    assert.equal(res, undefined, `write ${i + 1} of 3 should pass`);
  }
  const refused = await refusedBy(adminWriteRateLimit, asAdmin);
  assert.equal(refused?.status, 429, "the fourth write in a minute must be refused");

  // Reads are a different bucket and are untouched by exhausting the writes.
  const read = await refusedBy(adminRateLimit, asAdmin);
  assert.equal(read, undefined, "exhausting writes must not block reads");
});

test("two operators from one IP do not share a budget", async () => {
  const kv = memoryKV();
  const env = { RATE_LIMIT_ADMIN_PER_MINUTE: "5" };
  // The same IP - two people behind one office router. Keyed on the email, both get
  // their own allowance; keyed on the IP, one person's browsing would lock out the
  // other.
  const one = () => ctx(kv, env, { [ACCESS]: "one@example.com", "cf-connecting-ip": "198.51.100.7" });
  const two = () => ctx(kv, env, { [ACCESS]: "two@example.com", "cf-connecting-ip": "198.51.100.7" });

  for (let i = 0; i < 5; i++) await adminRateLimit(one(), async () => {});
  assert.equal((await refusedBy(adminRateLimit, one))?.status, 429, "the first operator is out");

  const other = await refusedBy(adminRateLimit, two);
  assert.equal(other, undefined, "the second operator must not be affected by the first's spending");
});

test("a 429 arrives in the error envelope the panel can render", async () => {
  const kv = memoryKV();
  const env = { RATE_LIMIT_ADMIN_PER_MINUTE: "1", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "1" };
  const asAdmin = () => ctx(kv, env, { [ACCESS]: "owner@example.com" });

  await adminRateLimit(asAdmin(), async () => {});
  const res = await refusedBy(adminRateLimit, asAdmin);
  assert.equal(res?.status, 429);
  // The console reads `error.message`; a bare string here renders as nothing at all,
  // which is how a rate limit turns into a silent failure.
  const envelope = (res?.body as { error: { code: string; message: string } }).error;
  assert.equal(typeof envelope, "object");
  assert.equal(envelope.code, "RATE_LIMITED");
  assert.ok(envelope.message.length > 0, "a 429 must say something the operator can act on");
});

test("the customer limiter is unchanged: still per IP, still the customer ceiling", async () => {
  const kv = memoryKV();
  const env = { RATE_LIMIT_API_PER_MINUTE: "2" };
  const ip = () => ctx(kv, env, { "cf-connecting-ip": "203.0.113.55" });

  await apiRateLimit(ip(), async () => {});
  await apiRateLimit(ip(), async () => {});
  const res = await refusedBy(apiRateLimit, ip);
  assert.equal(res?.status, 429, "the customer ceiling still applies");
  assert.equal((res?.body as { error: unknown }).error, "Too many requests");
});
test("admin limiter: a broken or slow-to-write KV never blocks or breaks an operator, and the ceiling still holds", async () => {
  const env = { RATE_LIMIT_ADMIN_PER_MINUTE: "3", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "2" };
  const admin = (kv: KVNamespace) => ctx(kv, env, { [ACCESS]: "owner@example.com" });

  // KV down for reads: the operator is let through (the session check already authenticated them).
  const downKv = { get: async () => { throw new Error("KV unavailable"); }, put: async () => { throw new Error("KV unavailable"); } } as unknown as KVNamespace;
  assert.equal(await refusedBy(adminRateLimit, () => admin(downKv)), undefined, "read passes when KV is down");
  assert.equal(await refusedBy(adminWriteRateLimit, () => admin(downKv)), undefined, "write passes when KV is down");

  // KV rejects the WRITE (KV allows 1 write/second/key): no error reaches the operator.
  const store = new Map<string, string>();
  const flakyPut = { get: async (k: string) => store.get(k) ?? null, put: async () => { throw new Error("KV PUT failed: 429"); } } as unknown as KVNamespace;
  assert.equal(await refusedBy(adminRateLimit, () => admin(flakyPut)), undefined, "a rejected counter write is invisible");

  // With a working KV the ceiling is still enforced: 3 reads pass, the 4th is refused; 2 writes pass, the 3rd is refused.
  const kv = memoryKV();
  for (let i = 0; i < 3; i++) assert.equal(await refusedBy(adminRateLimit, () => admin(kv)), undefined, `read ${i + 1} passes`);
  assert.equal((await refusedBy(adminRateLimit, () => admin(kv)))?.status, 429, "4th read is refused");
  for (let i = 0; i < 2; i++) assert.equal(await refusedBy(adminWriteRateLimit, () => admin(kv)), undefined, `write ${i + 1} passes`);
  assert.equal((await refusedBy(adminWriteRateLimit, () => admin(kv)))?.status, 429, "3rd write is refused");
});
