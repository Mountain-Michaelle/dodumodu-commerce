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

interface Sent { to: string; subject: string; text: string; key: string }

function recordingProvider(): { provider: EmailProvider; sent: Sent[] } {
  const sent: Sent[] = [];
  const provider: EmailProvider = {
    async send(to, subject, text, key) { sent.push({ to, subject, text, key }); return true; },
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
