import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerGitHubDispatch } from "./githubDeployTrigger";
import type { Env } from "../env";

const baseEnv: Env = {
  GITHUB_DEPLOY_TOKEN: "test-token",
  WORKER_URL: "",
  DEPLOY_TRIGGER_SECRET: "",
} as unknown as Env;

/** Runs a test with a stubbed fetch, restoring the real one afterwards. */
async function withFetch(impl: (url: string, init: RequestInit) => Promise<Response>, body: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as never;
  try { await body(); } finally { globalThis.fetch = original; }
}

test("missing GITHUB_DEPLOY_TOKEN is explicit unconfigured state, never dead pending", async () => {
  let fetchCalled = false;
  await withFetch(
    async () => { fetchCalled = true; throw new Error("must not be called"); },
    async () => {
      const result = await triggerGitHubDispatch({ ...baseEnv, GITHUB_DEPLOY_TOKEN: "" });
      assert.equal(result.status, "pending");
      assert.equal(result.retryable, true, "retryable so admin can retry after configuring the secret");
      assert.match(result.error ?? "", /not configured/);
      assert.equal(fetchCalled, false, "fetch must not be called when no token is configured");
      assert.equal(result.httpStatus, null);
    }
  );
});

test("successful GitHub dispatch is 'triggered' — acceptance only, not deployment", async () => {
  let capturedUrl = "";
  let capturedBody: unknown = null;
  let capturedAuth = "";
  await withFetch(
    async (url, init) => {
      capturedUrl = url;
      const hdr = init.headers as Record<string, string> | Headers | undefined;
      capturedAuth = hdr instanceof Headers ? hdr.get("Authorization") ?? "" : (hdr?.["Authorization"] ?? "");
      capturedBody = init.body;
      return new Response("", { status: 202 });
    },
    async () => {
      const result = await triggerGitHubDispatch(baseEnv);
      assert.equal(result.status, "triggered", "GitHub accepted the dispatch event");
      assert.equal(result.retryable, true);
      assert.equal(result.error, null);
      assert.equal(capturedUrl, "https://api.github.com/repos/Mountain-Michaelle/dodumodu-commerce/dispatches");
      assert.ok(capturedAuth.startsWith("Bearer "), "authorization header present");
      assert.equal(capturedAuth, "Bearer test-token");
      const payload = JSON.parse(String(capturedBody));
      assert.equal(payload.event_type, "storefront-deploy");
      assert.equal(payload.client_payload.source, "admin-publish");
      // A successful dispatch is acceptance-only: the status is "triggered", never "deployed" or "verified".
      assert.notEqual(result.status, "deployed");
      assert.notEqual(result.status, "verified");
    }
  );
});

test("non-2xx response is failed and retryable", async () => {
  await withFetch(
    async () => new Response("", { status: 401 }),
    async () => {
      const result = await triggerGitHubDispatch(baseEnv);
      assert.equal(result.status, "failed");
      assert.equal(result.retryable, true);
      assert.match(result.error ?? "", /HTTP 401/);
      assert.equal(result.httpStatus, 401);
    }
  );
});

test("timeout is failed and retryable", async () => {
  await withFetch(
    async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); },
    async () => {
      const result = await triggerGitHubDispatch(baseEnv);
      assert.equal(result.status, "failed");
      assert.equal(result.retryable, true);
      assert.match(result.error ?? "", /timed out/);
    }
  );
});

test("network error is failed and retryable", async () => {
  await withFetch(
    async () => { throw new Error("ENOTFOUND"); },
    async () => {
      const result = await triggerGitHubDispatch(baseEnv);
      assert.equal(result.status, "failed");
      assert.equal(result.retryable, true);
      assert.match(result.error ?? "", /ENOTFOUND/);
    }
  );
});
