import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSpam, decideRpf, browserLabel, type PhoneFacts } from "./spamDetect";
import { spamConfigFrom, emailList } from "./spamConfig";

const cfg = spamConfigFrom({});
const base: PhoneFacts = { trusted: false, prior: 0, similar: 0, burst: 0 };
const decide = (over: Partial<PhoneFacts>) => decideSpam({ ...base, ...over }, cfg);

test("defaults: 5 orders per phone per 24h, shadow action, alert-only RPF", () => {
  assert.equal(cfg.phoneMax, 5); assert.equal(cfg.windowHours, 24); assert.equal(cfg.action, "shadow"); assert.equal(cfg.rpfMode, "alert");
});
test("config is read from env and clamped", () => {
  const c = spamConfigFrom({ RL_SPAM_ACTION: "divert", RL_SPAM_PHONE_MAX_24H: "8", RL_SPAM_WINDOW_HOURS: "99999", RL_SPAM_BURST_MIN: "abc" });
  assert.equal(c.action, "divert"); assert.equal(c.phoneMax, 8); assert.equal(c.windowHours, 168); assert.equal(c.burstMin, 5);
  assert.equal(spamConfigFrom({ RL_SPAM_ACTION: "nonsense" }).action, "shadow");
});

// ---- who must NEVER be held ----
test("a returning customer (paid/delivered history) is never spam, however many orders", () => {
  assert.equal(decide({ trusted: true, prior: 40, similar: 40, burst: 40 }).spam, false);
});
test("an ordinary new customer: first orders are never held", () => {
  for (let prior = 0; prior < cfg.phoneMax; prior++) assert.equal(decide({ prior, similar: prior, burst: prior }).spam, false, `prior=${prior}`);
});
test("a new customer with many DIFFERENT orders at an ordinary pace is not held", () => {
  assert.equal(decide({ prior: 6, similar: 1, burst: 1 }).spam, false);
  assert.equal(decide({ prior: 12, similar: 2, burst: 4 }).spam, false);
});
test("a customer whose similar/burst counts are just under the limits is not held", () => {
  assert.equal(decide({ prior: 5, similar: cfg.similarMin - 1, burst: cfg.burstMin - 1 }).spam, false);
});

// ---- what IS spam ----
test("same phone repeating the same name/address after 5 orders is held", () => {
  const d = decide({ prior: 5, similar: 3, burst: 0 });
  assert.equal(d.spam, true); assert.match(d.reason!, /repeat/);
});
test("a rapid burst from one unproven phone is held even when the text differs", () => {
  const d = decide({ prior: 5, similar: 0, burst: 5 });
  assert.equal(d.spam, true); assert.match(d.reason!, /minutes/);
});
test("the threshold is configurable", () => {
  const strict = spamConfigFrom({ RL_SPAM_PHONE_MAX_24H: "2", RL_SPAM_SIMILAR_MIN: "1" });
  assert.equal(decideSpam({ ...base, prior: 2, similar: 1 }, strict).spam, true);
  assert.equal(decideSpam({ ...base, prior: 1, similar: 1 }, strict).spam, false);
});

// ---- RPF ----
test("RPF needs enough distinct untrusted phones from one device or address, with a higher bar for an address", () => {
  assert.equal(decideRpf("device", { untrustedPhones: 4, orders: 4 }, cfg), true);
  assert.equal(decideRpf("device", { untrustedPhones: 3, orders: 9 }, cfg), false);
  assert.equal(decideRpf("ip", { untrustedPhones: 5, orders: 5 }, cfg), false);
  assert.equal(decideRpf("ip", { untrustedPhones: 6, orders: 6 }, cfg), true);
  assert.equal(decideRpf("ip", { untrustedPhones: 50, orders: 50 }, spamConfigFrom({ RL_RPF_MODE: "off" })), false);
});

test("browser labels are coarse and never the raw user agent", () => {
  const chrome = "Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
  assert.equal(browserLabel(chrome), "Chrome 120 · Android");
  assert.equal(browserLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"), "Safari 17 · iOS");
  assert.match(browserLabel("Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/110 Mobile Safari/537.36 [FBAN/FB4A;FBAV/400.0]")!, /^Facebook app/);
  assert.match(browserLabel("python-requests/2.31")!, /^Script\/HTTP client/);
  assert.equal(browserLabel(""), null); assert.equal(browserLabel(undefined), null);
  assert.ok(browserLabel("x".repeat(5000))!.length <= 60);
});
test("emailList keeps only valid addresses, max 5", () => {
  assert.deepEqual(emailList("a@b.co, nope; c@d.com"), ["a@b.co", "c@d.com"]);
  assert.deepEqual(emailList(undefined), []);
  assert.equal(emailList("a@b.co,b@b.co,c@b.co,d@b.co,e@b.co,f@b.co").length, 5);
});
