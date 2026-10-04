import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, dispatchTo, isWithinWindow } from "./dispatcher";
import { trackingConfigFrom, type PlatformConfig } from "./config";
import { metaAdapter } from "./adapters/meta";
import { tiktokAdapter } from "./adapters/tiktok";
import type { NeutralEvent, FetchFn } from "./adapters/types";
import { registeredKeys } from "./registry";

/* Tracking must never be able to hurt an order.
 *
 * These tests use an injected fetch, so nothing here touches a network or needs
 * credentials. The scenarios that matter are the failures: a platform timing
 * out, returning 500, or being configured with a bad token while a second
 * platform works perfectly. In every one of those cases the ORDER must be
 * untouched and the two platforms must be judged independently.
 *
 * Every fixture is anchored to NOW and expressed as an OFFSET from it. An
 * earlier version of this file hardcoded calendar dates, and the whole suite
 * silently began failing the moment the calendar moved past the 7-day event
 * window - the expiry logic was working correctly and the fixtures were stale.
 * A test that breaks because time passed is a test lying about its own subject. */

// A fixed "now". The suite never calls Date.now() implicitly for an event.
const NOW = new Date("2026-02-01T12:00:00.000Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3600_000).toISOString();

/** An event `ageHours` old, so a window test is explicit about its own age. */
const eventOfAge = (ageHours: number): NeutralEvent => ({
  name: "purchase",
  eventId: "DM-2026-0001",
  eventTime: hoursAgo(ageHours),
  value: 450000,
  currency: "NGN",
  pageUrl: "https://shop.example/",
  user: { phoneHash: null, emailHash: null, city: "Lagos", country: "NG" },
  clickIds: {},
  cookies: {},
  clientIp: null,
  userAgent: null,
  content: [{ id: "7", quantity: 1 }],
});

const EVENT = eventOfAge(0);

const platform = (key: string, overrides: Partial<PlatformConfig> = {}): PlatformConfig => ({
  key, pixelId: "PIX", accessToken: "SECRET", apiVersion: "v1",
  testEventCode: null, maxEventAgeSeconds: 7 * 24 * 3600, ...overrides,
});

const enabled = (...keys: string[]) => trackingConfigFrom({
  TRACKING_ENABLED: "true",
  TRACKING_PLATFORMS: keys.join(","),
  META_PIXEL_ID: "PIX", META_ACCESS_TOKEN: "SECRET",
  TIKTOK_PIXEL_ID: "PIX", TIKTOK_ACCESS_TOKEN: "SECRET",
});

/** A fetch that answers per-URL, so two platforms can behave differently. */
const routingFetch = (behaviour: Record<string, () => Promise<Response>>): FetchFn =>
  async (url) => {
    const key = Object.keys(behaviour).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected url ${url}`);
    return behaviour[key]();
  };

const ok = () => Promise.resolve(new Response("{}", { status: 200 }));

/* ---- the on/off switch ---- */

test("tracking sends nothing at all when TRACKING_ENABLED is not true", async () => {
  // Not just "no adapters": no fetch calls whatsoever. A deployment that forgets
  // the flag must be silent rather than quietly advertising to third parties.
  let calls = 0;
  const config = trackingConfigFrom({ TRACKING_PLATFORMS: "meta,tiktok" });
  const outcomes = await dispatch(EVENT, config, async () => { calls++; return ok(); }, NOW);
  assert.deepEqual(outcomes, []);
  assert.equal(calls, 0);
});

/* ---- failure isolation ---- */

test("Meta failing does not stop TikTok from being sent", async () => {
  // The isolation property, tested in both directions below. If this ever fails,
  // one platform's outage silently stops the other's conversions.
  const fetch = routingFetch({
    "facebook.com": () => Promise.resolve(new Response("boom", { status: 500 })),
    "tiktokapis.com": ok,
  });
  const outcomes = await dispatch(EVENT, enabled("meta", "tiktok"), fetch, NOW);
  assert.deepEqual(outcomes.map((o) => [o.platform, o.status]), [
    ["meta", "failed"], ["tiktok", "sent"],
  ]);
  // A 5xx is worth retrying; that is what makes the cron useful.
  assert.equal(outcomes[0].retryable, true);
});

test("TikTok failing does not stop Meta from being sent", async () => {
  const fetch = routingFetch({
    "facebook.com": ok,
    "tiktokapis.com": () => Promise.reject(new Error("ECONNRESET")),
  });
  const outcomes = await dispatch(EVENT, enabled("meta", "tiktok"), fetch, NOW);
  assert.deepEqual(outcomes.map((o) => [o.platform, o.status]), [
    ["meta", "sent"], ["tiktok", "failed"],
  ]);
});

test("a platform timeout is recorded as retryable, and the other still succeeds", async () => {
  const fetch = routingFetch({
    "facebook.com": () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    },
    "tiktokapis.com": ok,
  });
  const outcomes = await dispatch(EVENT, enabled("meta", "tiktok"), fetch, NOW);
  assert.equal(outcomes[0].status, "failed");
  assert.equal(outcomes[0].error, "timeout");
  assert.equal(outcomes[1].status, "sent");
});

test("a bad access token fails without retrying", async () => {
  // 4xx means the request will never succeed as-is. Retrying it burns the
  // attempt budget and hides a configuration error behind an exhausted row.
  const outcome = await dispatchTo(
    EVENT,
    platform("meta"), async () => new Response("invalid token", { status: 401 }), NOW,
  );
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.retryable, false);
  assert.match(outcome.error!, /http_401/);
});

test("the dispatcher never throws, whatever the adapter does", async () => {
  // The contract the order flow depends on: this function returns data, always.
  const outcome = await dispatchTo(EVENT, platform("meta"), async () => {
    throw new TypeError("cannot read properties of undefined");
  }, NOW);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.retryable, true);
});

test("no outcome ever carries the access token", async () => {
  const outcome = await dispatchTo(
    EVENT,
    platform("meta"), async () => new Response("token rejected", { status: 400 }), NOW,
  );
  assert.ok(!JSON.stringify(outcome).includes("SECRET"));
  assert.ok(!JSON.stringify(outcome).includes("PIX"));
});

/* ---- config-driven degradation ---- */

test("an unknown platform key is skipped, not thrown on", async () => {
  // A typo in TRACKING_PLATFORMS must cost one platform's events and nothing else.
  const outcomes = await dispatch(
    EVENT, enabled("meta", "myspace"), routingFetch({ "facebook.com": ok }), NOW,
  );
  assert.deepEqual(outcomes.map((o) => [o.platform, o.status]), [
    ["meta", "sent"], ["myspace", "skipped"],
  ]);
  assert.equal(outcomes[1].error, "unknown_platform");
});

test("a platform with missing config is absent, not half-configured", async () => {
  // TikTok requested with no pixel id: it must not appear at all, because a
  // platform with half a config produces rows of failures that look like an outage.
  const config = trackingConfigFrom({
    TRACKING_ENABLED: "true",
    TRACKING_PLATFORMS: "meta,tiktok",
    META_PIXEL_ID: "PIX", META_ACCESS_TOKEN: "SECRET",
  });
  // Resolution drops it, because there is no usable config to send with.
  assert.deepEqual([...config.platforms.keys()], ["meta"]);
  const outcomes = await dispatch(EVENT, config, routingFetch({ "facebook.com": ok }), NOW);
  // But it is still REPORTED, as a skipped row naming the real cause. A missing
  // secret must be visible in the log; disappearing is how a pixel runs dead
  // for a month with nobody noticing.
  assert.deepEqual(outcomes.map((o) => [o.platform, o.status]), [
    ["meta", "sent"], ["tiktok", "skipped"],
  ]);
  assert.equal(outcomes[1].error, "missing_config");
});

test("the template adapter is NOT registered", async () => {
  // Registering it would send real conversions to api.example.com.
  assert.ok(!registeredKeys().includes("yourplatform"));
  assert.deepEqual(registeredKeys().sort(), ["meta", "tiktok"]);
});

test("both adapters satisfy the same contract", () => {
  // The plug-in promise, checked against the real adapters rather than the
  // template, so a signature drift breaks the build here.
  for (const adapter of [metaAdapter, tiktokAdapter]) {
    assert.equal(typeof adapter.key, "string");
    assert.equal(typeof adapter.buildPayload, "function");
    assert.equal(typeof adapter.send, "function");
    assert.equal(adapter.eventNameMap.purchase, "Purchase");
  }
  assert.equal(metaAdapter.key, "meta");
  assert.equal(tiktokAdapter.key, "tiktok");
});

/* ---- the event-age window ---- */

test("a fresh event is sent", async () => {
  const outcome = await dispatchTo(EVENT, platform("meta"), async () => ok(), NOW);
  assert.equal(outcome.status, "sent");
});

test("a pay-on-delivery event days old is still inside the window", async () => {
  // The reason the window exists at all: cash collected on day 3 is a real
  // conversion and must still be reported.
  const outcome = await dispatchTo(eventOfAge(72), platform("meta"), async () => ok(), NOW);
  assert.equal(outcome.status, "sent");
});

test("an event older than the platform window is expired, not sent", async () => {
  // Meta's documented limit: an event_time more than 7 days in the past is
  // rejected for the ENTIRE request. Sending one anyway costs a request and
  // teaches us nothing, and recording `expired` makes the gap visible.
  let called = false;
  const outcome = await dispatchTo(eventOfAge(24 * 9), platform("meta"), async () => {
    called = true;
    return ok();
  }, NOW);
  assert.equal(outcome.status, "expired");
  assert.equal(outcome.retryable, false);
  assert.equal(called, false, "an expired event must not hit the network at all");
});

test("the window is per platform, from config", () => {
  const strict = platform("meta", { maxEventAgeSeconds: 3600 });
  const lenient = platform("meta", { maxEventAgeSeconds: 30 * 24 * 3600 });
  const event = eventOfAge(48);
  assert.equal(isWithinWindow(event, strict, NOW), false);
  assert.equal(isWithinWindow(event, lenient, NOW), true);
});

test("the default window is 7 days, which is Meta's documented limit", () => {
  // Read from the live docs rather than remembered: "The event_time can be up to
  // 7 days before you send an event to Facebook."
  const config = trackingConfigFrom({
    META_PIXEL_ID: "PIX", META_ACCESS_TOKEN: "SECRET",
  });
  assert.equal(config.platforms.get("meta")!.maxEventAgeSeconds, 7 * 24 * 3600);
  // Exactly 7 days is still accepted; one second past it is not.
  assert.equal(isWithinWindow(eventOfAge(24 * 7), platform("meta"), NOW), true);
  assert.equal(isWithinWindow(eventOfAge(24 * 7 + 0.01), platform("meta"), NOW), false);
});

test("a clock slightly ahead does not discard a real conversion", () => {
  // Skew should never be the reason a genuine purchase is lost.
  const config = platform("meta", { maxEventAgeSeconds: 3600 });
  const future = { ...EVENT, eventTime: new Date(NOW.getTime() + 30_000).toISOString() };
  assert.equal(isWithinWindow(future, config, NOW), true);
});