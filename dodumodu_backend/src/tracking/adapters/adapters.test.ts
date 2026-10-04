import { test } from "node:test";
import assert from "node:assert/strict";
import { metaAdapter } from "./meta";
import { tiktokAdapter } from "./tiktok";
import { interpretResponse, type NeutralEvent } from "./types";
import type { PlatformConfig } from "../config";

/* The wire format is the part that cannot be reviewed by reading the code.
 *
 * A payload with the right VALUES under the wrong KEYS is rejected by the
 * platform, and the rejection looks exactly like a network failure from here, so
 * the failure mode is silent: events stop, nothing throws, and the ad account
 * simply stops learning. These tests pin the key names against the docs rather
 * than against whatever the adapter happens to produce. */

const event: NeutralEvent = {
  name: "purchase",
  eventId: "DM-2026-0001",
  eventTime: "2026-02-01T10:05:00.000Z",
  value: 450000,
  currency: "NGN",
  pageUrl: "https://shop.example/products/glow-serum/",
  user: { phoneHash: "a".repeat(64), emailHash: null, city: "Lagos", country: "NG" },
  clickIds: { fbclid: "abc123", ttclid: "tt-999" },
  cookies: { fbp: "fb.1.155", ttp: "tt-1" },
  clientIp: "203.0.113.9",
  userAgent: "Mozilla/5.0 (iPhone)",
  content: [{ id: "7", quantity: 2 }],
};

const config = (key: string): PlatformConfig => ({
  key,
  pixelId: "PIXEL123",
  accessToken: "SECRET",
  apiVersion: "v21.0",
  testEventCode: null,
  maxEventAgeSeconds: 604800,
});

const meta = () => metaAdapter.buildPayload(event, config("meta")) as Record<string, any>;
const tiktok = () => tiktokAdapter.buildPayload(event, config("tiktok")) as Record<string, any>;

/* ---- the neutral-to-platform event name mapping ---- */

test("a neutral purchase maps to Purchase on BOTH platforms", () => {
  // This is the one thing that was checked against the docs rather than assumed.
  // TikTok's APP event for this is "CompletePayment", but its WEB event — the
  // one this storefront produces — is "Purchase", same as Meta. Sending
  // "CompletePayment" here would be accepted by the API and then ignored by the
  // Ads Manager as an unrecognised standard event.
  assert.equal(metaAdapter.eventNameMap.purchase, "Purchase");
  assert.equal(tiktokAdapter.eventNameMap.purchase, "Purchase");
  assert.equal(meta().data.event_name, "Purchase");
  assert.equal(tiktok().event, "Purchase");
});

test("every neutral browser event maps on both platforms", () => {
  for (const [neutral, metaName] of Object.entries(metaAdapter.eventNameMap)) {
    const tiktokName = tiktokAdapter.eventNameMap[neutral as keyof typeof tiktokAdapter.eventNameMap];
    assert.equal(metaName, tiktokName, `${neutral} differs between platforms`);
  }
});

/* ---- Meta ---- */

test("Meta nests the event under data and uses unix seconds", () => {
  const body = meta();
  assert.equal(body.data.action_source, "website");
  // Meta wants epoch seconds, not an ISO string — an ISO string here is silently
  // interpreted as 1970 and the event is attributed to a 56-year-old click.
  assert.equal(body.data.event_time, 1769940300);
  assert.equal(typeof body.data.event_time, "number");
});

test("Meta carries user_data as an ARRAY of objects", () => {
  // Not a flat object. This shape is the single most common CAPI mistake.
  const body = meta();
  assert.ok(Array.isArray(body.data.user_data));
  assert.equal(body.data.user_data.length, 1);
  assert.equal(body.data.user_data[0].ph, "a".repeat(64));
  assert.equal(body.data.user_data[0].ct, "Lagos");
});

test("Meta derives fbc from fbclid when no fbc cookie was captured", () => {
  // fbc is a DERIVED value, not a received one. With no cookie it is still sent,
  // minus the cookie segment, because a click id alone beats nothing.
  const withoutFbc = { ...event, cookies: { fbp: "fb.1.155" } };
  const body = metaAdapter.buildPayload(withoutFbc, config("meta")) as Record<string, any>;
  assert.equal(body.data.user_data[0].fbc, "fb.abc123.fb.1.155");
});

test("Meta sends no fbc at all when there is no click to derive one from", () => {
  const organic = { ...event, clickIds: {}, cookies: {} };
  const body = metaAdapter.buildPayload(organic, config("meta")) as Record<string, any>;
  assert.equal(body.data.user_data[0].fbc, undefined);
});

test("Meta carries value in minor units under custom_data", () => {
  const body = meta();
  assert.equal(body.data.custom_data.value, 450000);
  assert.equal(body.data.custom_data.currency, "NGN");
  assert.deepEqual(body.data.custom_data.content_ids, ["7"]);
});

test("Meta passes IP and user agent unhashed, outside user_data", () => {
  const body = meta();
  assert.equal(body.client_ip_address, "203.0.113.9");
  assert.equal(body.client_user_agent, "Mozilla/5.0 (iPhone)");
});

test("a test event code is included only when configured", () => {
  assert.equal(meta().test_event_code, undefined);
  const withCode = metaAdapter.buildPayload(event, { ...config("meta"), testEventCode: "TEST123" }) as Record<string, any>;
  assert.equal(withCode.test_event_code, "TEST123");
});

/* ---- TikTok ---- */

test("TikTok puts event fields at the TOP level, not under data", () => {
  // The opposite of Meta. Wrapping TikToks payload in a Meta-shaped envelope is
  // the other very common copy-paste error.
  const body = tiktok();
  assert.equal(body.data, undefined);
  assert.equal(body.event, "Purchase");
  assert.equal(body.event_source, "web");
  assert.equal(body.event_id, "DM-2026-0001");
});

test("TikTok takes an ISO-8601 event time, not unix seconds", () => {
  const body = tiktok();
  assert.equal(body.event_time, "2026-02-01T10:05:00.000Z");
  // TikTok ALSO wants a unix `timestamp` field, which is easy to miss.
  assert.equal(body.timestamp, 1769940300);
});

test("TikTok uses its own user field names", () => {
  const body = tiktok();
  // phone_number / email, not Meta's ph / em, and under `user`, not `user_data`.
  assert.equal(body.user.phone_number, "a".repeat(64));
  assert.equal(body.user.ttp, "tt-1");
  assert.equal(body.user.ttclid, "tt-999");
});

test("TikTok stringifies content ids and sends ip/user_agent unhashed", () => {
  const body = tiktok();
  assert.deepEqual(body.content_ids, ["7"]);
  assert.equal(body.ip, "203.0.113.9");
  assert.equal(body.user_agent, "Mozilla/5.0 (iPhone)");
});

/* ---- shared response handling ---- */

test("a 2xx is a success", async () => {
  const result = await interpretResponse(new Response("{}", { status: 200 }));
  assert.deepEqual(result, { ok: true, retryable: false, error: null });
});

test("429 and 5xx are retryable", async () => {
  for (const status of [429, 500, 502, 503]) {
    assert.equal((await interpretResponse(new Response("", { status }))).retryable, true, `${status} should retry`);
  }
});

test("a 4xx is NOT retryable, so a bad token cannot loop forever", async () => {
  // Retrying a request we will never get right burns the attempt budget and
  // hides a configuration error behind an exhausted row.
  for (const status of [400, 401, 403, 404]) {
    const result = await interpretResponse(new Response("bad token", { status }));
    assert.equal(result.retryable, false, `${status} must not retry`);
    assert.match(result.error!, /http_\d+/);
  }
});

test("a timeout is retryable", async () => {
  assert.deepEqual(await interpretResponse(new Response(""), true), {
    ok: false, retryable: true, error: "timeout",
  });
});

/* ---- transport ---- */

test("a thrown fetch is retryable, and names the cause", async () => {
  const result = await metaAdapter.send({}, config("meta"), async () => {
    throw new Error("socket hang up");
  });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.error, "socket hang up");
});

test("an aborted fetch reports as a timeout, not as a message", async () => {
  const result = await tiktokAdapter.send({}, config("tiktok"), async () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  });
  assert.equal(result.error, "timeout");
});

test("the access token never appears in a result", async () => {
  // A token leaking into a log row or an admin response is unrecoverable.
  const result = await metaAdapter.send({}, config("meta"), async () => new Response("nope", { status: 400 }));
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});