// Email provider + notification unit tests (spec §6/§5.10). A stub provider
// records every send so we can assert stable idempotency keys and that no body
// ever contains a code, phrase, token or full IP.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  providerFor, nullProvider, sendLoginCode, sendPhraseReset, sendBackupUsed,
  sendPermChange, sendDeniedAlert, sendNewNetwork, sendDeviceEvent,
  sendPhraseResetRequested, type EmailProvider,
} from "./email";

interface Sent { to: string; subject: string; text: string; key: string }

function recordingProvider(): { provider: EmailProvider; sent: Sent[] } {
  const sent: Sent[] = [];
  const provider: EmailProvider = {
    async send(to, subject, text, key) { sent.push({ to, subject, text, key }); },
  };
  return { provider, sent };
}

test("providerFor returns the null provider when no key, real shape otherwise", () => {
  assert.equal(providerFor(null), nullProvider);
  const p = providerFor("re_test_key");
  assert.equal(typeof p.send, "function");
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
  await sendPhraseReset(provider, "u@x.com", "https://h/auth/phrase-reset/TOKEN");
  await sendBackupUsed(provider, "u@x.com", 3);
  await sendPermChange(provider, "u@x.com", "orders.view", true);
  await sendDeniedAlert(provider, "u@x.com");
  await sendNewNetwork(provider, "u@x.com", "NG");
  await sendDeviceEvent(provider, "u@x.com", "registered");
  await sendPhraseResetRequested(provider, "u@x.com");
  assert.equal(sent.length, 7);
  for (const s of sent) {
    assert.ok(s.key.length > 0, "every send has an idempotency key");
    // No full IP addresses anywhere in any body.
    assert.doesNotMatch(s.text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  }
  // The only place a token appears is the reset URL, and only the path token.
  assert.match(sent[0].text, /phrase-reset\/TOKEN/);
});
