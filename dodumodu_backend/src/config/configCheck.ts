import { isUsableSecret } from "../shared/secureEqual";
import { isNonProduction } from "./environment";

/**
 * What is wrong with this deployment's configuration, by NAME only - a value never appears in the output,
 * so the result is safe to log. Production only: sandbox and local runs legitimately leave these empty.
 *
 * Deliberately a report, not a gate. Each feature already fails closed on its own (a missing cron secret
 * refuses the cron call, a missing webhook secret refuses the webhook, the admin refuses an untrusted
 * identity), so a missing optional secret must not take the storefront - and with it, orders - offline.
 */
export function configProblems(env: Record<string, unknown>): string[] {
  const environment = typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : undefined;
  if (isNonProduction(environment)) return [];
  const problems: string[] = [];
  const text = (key: string): string | undefined => (typeof env[key] === "string" ? (env[key] as string) : undefined);

  for (const key of ["DATABASE_URL", "RECONCILE_CRON_SECRET", "OPAY_WEBHOOK_SECRET", "OPAY_SECRET_KEY", "TURNSTILE_SECRET_KEY"]) {
    if (!isUsableSecret(text(key))) problems.push(`${key}: missing or a placeholder`);
  }
  if (text("ADMIN_AUTH_V2") !== "1") problems.push("ADMIN_AUTH_V2: must be exactly \"1\" in production");
  if (text("TRUST_ACCESS_HEADER") === "1") problems.push("TRUST_ACCESS_HEADER: the Access identity header is trusted; only valid when Access is the sole way in");

  const origins = (text("ALLOWED_ORIGINS") ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (origins.length === 0) problems.push("ALLOWED_ORIGINS: empty");
  for (const o of origins) {
    if (o.startsWith("*.")) continue;
    let ok = false;
    try { const u = new URL(o); ok = u.protocol === "https:" && u.origin === o && !/your-|example\./i.test(u.hostname); } catch { ok = false; }
    if (!ok) problems.push(`ALLOWED_ORIGINS: "${o}" is not a clean https origin`);
  }
  return problems;
}

let reported = false;
/** Logs the problems once per isolate (names only). Never throws, never blocks a request. */
export function reportConfigOnce(env: Record<string, unknown>, log: (problems: string[]) => void): void {
  if (reported) return;
  reported = true;
  try {
    const problems = configProblems(env);
    if (problems.length > 0) log(problems);
  } catch { /* reporting must never affect a request */ }
}
/** Test hook. */
export function resetConfigReport(): void { reported = false; }
