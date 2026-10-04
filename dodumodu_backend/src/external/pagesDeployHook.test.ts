import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerPagesDeploy } from "./pagesDeployHook";

/* The deploy hook is an EXTERNAL SIDE EFFECT, and the one property that matters
   most is that it cannot fail in a way that harms a publish that already
   succeeded. Every case here must resolve, never throw. */

const env = (hook: string) => ({ PAGES_DEPLOY_HOOK: hook }) as never;

/**
 * Runs a stubbed fetch while `body` executes, then restores the real one.
 *
 * The return type is generic because several tests need the value the hook
 * returned - forcing every caller through a void helper meant asserting on it
 * outside the scope where it was produced, which is how an assertion ends up
 * checking nothing.
 */
async function withFetch<T>(
  impl: (url: string, init: RequestInit) => Promise<Response>,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as never;
  try { return await body(); } finally { globalThis.fetch = original; }
}

test("a 2xx from Cloudflare means triggered - and nothing stronger than that", async () => {
  const result = await withFetch(
    async () => new Response("", { status: 201 }),
    () => triggerPagesDeploy(env("https://api.example.com/deploy/abc")),
  );
  // "triggered" must never be reported as "deployed": a 200 means the request was
  // received, not that a build ran or shipped.
  assert.equal(result.status, "triggered");
  assert.equal(result.httpStatus, 201);
  assert.equal(result.error, null);
  assert.equal(result.retryable, true);
});

test("a non-2xx is a failure with Cloudflare's own status, not a guess", async () => {
  const result = await withFetch(
    async () => new Response("nope", { status: 403 }),
    () => triggerPagesDeploy(env("https://api.example.com/deploy/abc")),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.httpStatus, 403);
  assert.match(result.error ?? "", /HTTP 403/);
  assert.equal(result.retryable, true);
});

test("a network failure is reported, never thrown", async () => {
  const result = await withFetch(
    async () => { throw new Error("ECONNREFUSED"); },
    () => triggerPagesDeploy(env("https://api.example.com/deploy/abc")),
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /Could not reach/);
  assert.equal(result.retryable, true);
});

test("an aborted request (the timeout) is a failure, not an exception", async () => {
  // AbortSignal.timeout surfaces as an AbortError whose name varies by runtime;
  // either way it must come back as data, because this is awaited inside a publish.
  const result = await withFetch(
    async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
    () => triggerPagesDeploy(env("https://api.example.com/deploy/abc")),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, true);
});

test("no hook configured is 'pending', not 'failed' - that is the local case", async () => {
  // Marking a local publish as failed would be wrong: there was never a hook to
  // fail, and the admin never asked for a rebuild.
  const result = await withFetch(async () => { throw new Error("must not be called"); }, async () => {
    return triggerPagesDeploy(env(""));
  });
  assert.equal(result.status, "pending");
  assert.equal(result.error, null);
  assert.equal(result.retryable, false);
});

test("a whitespace-only hook is treated as unset", async () => {
  const result = await triggerPagesDeploy(env("   "));
  assert.equal(result.status, "pending");
});

test("an undefined hook is treated as unset, not as a crash", async () => {
  const result = await triggerPagesDeploy({} as never);
  assert.equal(result.status, "pending");
});

test("the hook is POSTed with a timeout signal attached", async () => {
  // Without a signal, a hanging Cloudflare edge would hold an admin's publish open
  // indefinitely with no way to tell whether it had been accepted.
  let seen: { method?: string; hasSignal?: boolean } = {};
  await withFetch(async (_url, init) => {
    seen = { method: init?.method, hasSignal: Boolean(init?.signal) };
    return new Response("", { status: 200 });
  }, () => triggerPagesDeploy(env("https://api.example.com/deploy/abc")));
  assert.equal(seen.method, "POST");
  assert.equal(seen.hasSignal, true, "every hook call must carry an abort signal");
});

test("the reported duration is real and non-negative", async () => {
  const result = await withFetch(
    async () => new Response("", { status: 200 }),
    () => triggerPagesDeploy(env("https://api.example.com/deploy/abc")),
  );
  assert.ok(result.durationMs >= 0);
});