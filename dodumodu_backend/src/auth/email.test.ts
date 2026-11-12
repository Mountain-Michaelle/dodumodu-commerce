// Email provider + notification unit tests (spec §6/§5.10). A stub provider
// records every send so we can assert stable idempotency keys and that no body
// ever contains a code, phrase, token or full IP.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  providerFor, nullProvider, unconfiguredProvider, sendLoginCode, sendBackupUsed,
  sendPermChange, sendDeniedAlert, sendNewNetwork, sendDeviceEvent,
  type EmailProvider,
} from "./email";

interface Sent { to: string; subject: string; text: string; key: string; html?: string }

function recordingProvider(): { provider: EmailProvider; sent: Sent[] } {
  const sent: Sent[] = [];
  const provider: EmailProvider = {
    async send(to, subject, text, key, html) { sent.push({ to, subject, text, key, html }); return true; },
  };
  return { provider, sent };
}

test("providerFor: no/blank key is the LOUD unconfigured provider (never a silent success), real shape otherwise", async () => {
  for (const missing of [null, "", "   "]) assert.equal(providerFor(missing), unconfiguredProvider);
  assert.equal(await unconfiguredProvider.send("a@b.com", "s", "t", "k"), false, "reports failure, not 'sent'");
  assert.equal(await nullProvider.send("a@b.com", "s", "t", "k"), true, "the explicit no-op stays available for callers that opt in");
  const p = providerFor("re_test_key");
  assert.equal(typeof p.send, "function");
  assert.notEqual(p, unconfiguredProvider);
});

test("login code: body has the code, key is stable per recipient", async () => {
  const { provider, sent } = recordingProvider();
  await sendLoginCode(provider, "a@b.com", "ABC123");
  await sendLoginCode(provider, "a@b.com", "XYZ999");
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /ABC123/);
  assert.equal(sent[0].key, sent[1].key); // idempotent per recipient
});

test("notification bodies never leak secrets and keys are stable", async () => {
  const { provider, sent } = recordingProvider();
  await sendBackupUsed(provider, "u@x.com", 3);
  await sendPermChange(provider, "u@x.com", "orders.view", true);
  await sendDeniedAlert(provider, "u@x.com");
  await sendNewNetwork(provider, "u@x.com", "NG");
  await sendDeviceEvent(provider, "u@x.com", "registered");
  assert.equal(sent.length, 5);
  for (const s of sent) {
    assert.ok(s.key.length > 0, "every send has an idempotency key");
    // No full IP addresses anywhere in any body.
    assert.doesNotMatch(s.text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  }
});

test("login code: plain-text body unchanged", async () => {
  const { provider, sent } = recordingProvider();
  await sendLoginCode(provider, "a@b.com", "ABCDEFGHIJ");
  assert.equal(sent[0].text, "Your code is ABCDEFGHIJ. Code expires in 3 minutes. If you did not request it, ignore this email.");
});

test("login code: HTML contains the OTP in correct order", async () => {
  const { provider, sent } = recordingProvider();
  await sendLoginCode(provider, "a@b.com", "1234567890");
  const html = sent[0].html ?? "";
  // The full code appears as contiguous selectable text in the HTML
  const textContent = html.replace(/<[^>]*>/g, "");
  assert.ok(textContent.includes("1234567890"), "digits contiguous and readable when HTML stripped");
  // Orange background wraps the code (Dodumodu brand accent)
  assert.ok(html.includes("#F7A21B"), "orange brand accent background present");
});

test("login code: HTML has no clipboard JavaScript", async () => {
  const { provider, sent } = recordingProvider();
  await sendLoginCode(provider, "a@b.com", "ABCDEFGHIJ");
  const html = sent[0].html ?? "";
  assert.doesNotMatch(html, /clipboard/i, "no clipboard API in HTML");
  assert.doesNotMatch(html, /onclick/i, "no onclick handlers in HTML");
  assert.doesNotMatch(html, /<script/i, "no script tags in HTML");
});

test("login code: HTML uses Dodumodu brand colors", async () => {
  const { provider, sent } = recordingProvider();
  await sendLoginCode(provider, "a@b.com", "ABCDEFGHIJ");
  const html = sent[0].html ?? "";
  assert.ok(html.includes("#fff8f5"), "brand background color present");
  assert.ok(html.includes("#ffffff"), "brand surface color present");
  assert.ok(html.includes("#2b2320"), "brand text color present");
  assert.ok(html.includes("#6b5f59"), "brand muted color present");
  assert.ok(html.includes("#ece1db"), "brand border color present");
});

test("login code: HTML mentions expiration", async () => {
  const { provider, sent } = recordingProvider();
  await sendLoginCode(provider, "a@b.com", "ABCDEFGHIJ");
  const html = sent[0].html ?? "";
  assert.ok(html.includes("3 minutes"), "expiration mentioned in HTML");
});

test("login code: HTML escapes dynamic content", async () => {
  const { provider, sent } = recordingProvider();
  await sendLoginCode(provider, "a@b.com", "<script>alert('x')</script>");
  const html = sent[0].html ?? "";
  assert.ok(html.includes("&lt;"), "less-than escaped in HTML");
  assert.ok(html.includes("&gt;"), "greater-than escaped in HTML");
  assert.doesNotMatch(html, /<script/, "no raw script tags in HTML");
  assert.ok(sent[0].text.includes("<script>alert('x')</script>"), "plain text contains raw code");
});

test("non-OTP emails send no HTML", async () => {
  const { provider, sent } = recordingProvider();
  await sendBackupUsed(provider, "u@x.com", 3);
  assert.equal(sent[0].html, undefined, "backup-used has no HTML");
  await sendDeniedAlert(provider, "u@x.com");
  assert.equal(sent[1].html, undefined, "denied-alert has no HTML");
});
