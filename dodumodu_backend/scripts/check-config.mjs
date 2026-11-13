// Pre-deploy guard: node scripts/check-config.mjs   (npm run check:config)
// Fails when wrangler.toml [vars] holds a secret, a FILL-IN placeholder or a malformed origin list.
import { readFileSync } from "node:fs";
const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const vars = (toml.split("[vars]")[1] ?? "").split(/\n\[/)[0];
const live = vars.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const SECRET = /^(OPAY_(SECRET_KEY|WEBHOOK_SECRET|PUBLIC_KEY|MERCHANT_ID)|DEPLOY_TRIGGER_SECRET|GITHUB_DEPLOY_TOKEN|RECONCILE_CRON_SECRET|TURNSTILE_SECRET_KEY|RESEND_API_KEY|DATABASE_URL|ANALYTICS_IP_HMAC_SECRET)\s*=/;
const problems = [];
for (const l of live) {
  const name = l.split("=")[0].trim();
  if (/FILL-IN/i.test(l)) problems.push(`${name}: placeholder value`);
  if (SECRET.test(l)) problems.push(`${name}: a secret must be set with "wrangler secret put", not in [vars]`);
  if (/https:\/\/https:\/\//.test(l)) problems.push(`${name}: malformed URL (https://https://)`);
}
if (problems.length) { console.error("wrangler.toml problems:\n - " + problems.join("\n - ")); process.exit(1); }
console.log("wrangler.toml [vars]: ok");
