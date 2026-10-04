import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../env";
import { verifyTurnstile } from "./orders";

/* verifyTurnstile is the only thing standing between a public POST and a written
   order, and orderSchema.ts deliberately does NOT duplicate it - an empty token
   is a valid shape there. That split is only safe while these rules hold, so they
   are pinned here: skipped outside production with no secret, and fail closed
   everywhere else. fetch is stubbed, so no real round trip happens. */
const realFetch = globalThis.fetch;
const restore = () => { globalThis.fetch = realFetch; };

function envWith(over: Partial<Env>): Env {
  return { ENVIRONMENT: "sandbox", TURNSTILE_SECRET_KEY: "", ...over } as Env;
}

function stubCloudflare(success: boolean) {
  globalThis.fetch = (async () => new Response(JSON.stringify({ success }), {
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;
}

test("outside production with no secret the challenge is skipped", async () => {
  // The local build ships no widget (an empty site key disables it), so the page
  // legitimately posts an empty token. This is the case the schema's empty token
  // exists for, and it must not be a second, contradictory gate.
  restore();
  assert.equal(await verifyTurnstile(envWith({}), "", ""), true);
});

test("in production with no secret it fails closed, never open", async () => {
  // The dangerous misconfiguration: a deployed Worker whose secret was never
  // set. "Cannot verify" has to mean "refuse", not "allow".
  restore();
  assert.equal(await verifyTurnstile(envWith({ ENVIRONMENT: "production" }), "", ""), false);
});

test("with a secret, only Cloudflare's own answer counts", async () => {
  const env = envWith({ TURNSTILE_SECRET_KEY: "0xsecret" });
  try {
    stubCloudflare(true);
    assert.equal(await verifyTurnstile(env, "good-token", "1.2.3.4"), true);

    stubCloudflare(false);
    assert.equal(await verifyTurnstile(env, "bad-token", "1.2.3.4"), false);
  } finally {
    restore();
  }
});

test("with a secret configured, an empty token is not waved through", async () => {
  // Identical environment to the test above - only the token differs. This is what
  // makes the schema's empty token safe: the schema accepts it, this decides.
  const env = envWith({ TURNSTILE_SECRET_KEY: "0xsecret" });
  try {
    stubCloudflare(false);
    assert.equal(await verifyTurnstile(env, "", "1.2.3.4"), false);
  } finally {
    restore();
  }
});
