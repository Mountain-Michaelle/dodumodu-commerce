import { test } from "node:test";
import assert from "node:assert/strict";
import { heldOrderTemplate } from "./held-order";
import { rpfAlertTemplate } from "./rpf-alert";
import { emailLayout } from "../layout";

const held = {
  id: 7, customerName: `<img src=x onerror=alert(1)> Ada`, phone: "08012345678", reason: "6 orders in 24h", reference: "DDM-1",
  ip: "203.0.113.5", deviceId: "dev-1", browser: "Chrome on Android", clientKind: "browser", receivedAt: "2026-11-13T00:00:00Z",
  fields: [["address", `<script>x</script> 1 Lagos Rd`], ["quantity", "2"]] as const,
};

test("held-order mail: escapes everything a customer typed, has a text part, and a stable idempotency key", () => {
  const m = heldOrderTemplate(held);
  assert.match(m.subject, /^\[HELD - SPAM\?\]/);
  assert.ok(!m.html.includes("<img src=x"), "customer markup is not injected into the HTML");
  assert.ok(!m.html.includes("<script>x"), "payload markup is not injected into the HTML");
  assert.ok(m.html.includes("&lt;img src=x onerror=alert(1)&gt;") || !m.html.includes("onerror="), "shown as inert text");
  assert.match(m.text, /Release as order/);
  assert.match(m.text, /Reference shown to customer: DDM-1/);
  assert.equal(m.idempotencyKey, "held-order:7");
  assert.match(m.html, /Nothing was blocked/, "alert footer, not the sign-in-code footer");
  assert.doesNotMatch(m.html, /didn't request this code/);
});

test("rpf mail: says nothing was blocked, names the device and address, and keys on the alert id", () => {
  const m = rpfAlertTemplate({ id: 3, scope: "device", distinctPhones: 4, orderCount: 5, windowMinutes: 60, ip: "198.51.100.9", deviceId: "d-9",
    browser: "Safari on iPhone", clientKind: "browser", orderIds: [10, 11, 12], raisedAt: "2026-11-13T00:00:00Z" });
  assert.equal(m.subject, "[RPF SUSPECT] 4 different phones from one device");
  assert.match(m.text, /STORED normally and nothing was blocked/);
  assert.match(m.text, /Order ids: 10, 11, 12/);
  assert.match(m.html, /198\.51\.100\.9/);
  assert.equal(m.idempotencyKey, "rpf-alert:3");
  assert.match(rpfAlertTemplate({ id: 4, scope: "ip", distinctPhones: 6, orderCount: 6, windowMinutes: 60, ip: null, deviceId: null, browser: null,
    clientKind: null, orderIds: [], raisedAt: "x" }).subject, /from one address$/);
});

test("the shared layout keeps its original footer unless a mail asks for another one", () => {
  assert.match(emailLayout({ title: "t", body: "b" }), /If you didn't request this code, you can safely ignore this email\./);
  assert.match(emailLayout({ title: "t", body: "b", footer: "custom" }), /custom/);
});
