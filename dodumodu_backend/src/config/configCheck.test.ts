import { test } from "node:test";
import assert from "node:assert/strict";
import { configProblems, reportConfigOnce, resetConfigReport } from "./configCheck";

const good = {
  ENVIRONMENT: "production", DATABASE_URL: "postgres://u:p@h/db", RECONCILE_CRON_SECRET: "abcdef123456", OPAY_WEBHOOK_SECRET: "whsec_1",
  OPAY_SECRET_KEY: "sk_1", TURNSTILE_SECRET_KEY: "0x4AAA", ADMIN_AUTH_V2: "1", ALLOWED_ORIGINS: "https://shop.dodumodu.com,*.pages.dev",
};
test("a complete production config has no problems", () => assert.deepEqual(configProblems(good), []));
test("sandbox and unset environment are handled: sandbox is silent, unset is treated as production", () => {
  assert.deepEqual(configProblems({ ENVIRONMENT: "sandbox" }), []);
  assert.ok(configProblems({}).length > 0);
});
test("placeholders, blanks and bad origins are named but never echoed", () => {
  const out = configProblems({ ...good, OPAY_WEBHOOK_SECRET: "FILL-IN-via-wrangler-secret-put", RECONCILE_CRON_SECRET: "", ADMIN_AUTH_V2: "true",
    ALLOWED_ORIGINS: "https://https://your-worker.workers.dev" });
  const text = out.join("\n");
  for (const name of ["OPAY_WEBHOOK_SECRET", "RECONCILE_CRON_SECRET", "ADMIN_AUTH_V2", "ALLOWED_ORIGINS"]) assert.match(text, new RegExp(name));
  assert.doesNotMatch(text, /FILL-IN-via/);
});
test("reporting happens once and never throws", () => {
  resetConfigReport(); let n = 0;
  reportConfigOnce({}, () => { n++; }); reportConfigOnce({}, () => { n++; });
  assert.equal(n, 1);
  resetConfigReport();
  assert.doesNotThrow(() => reportConfigOnce({}, () => { throw new Error("x"); }));
});
