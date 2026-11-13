/**
 * Deployments that are allowed to run with local conveniences (an injected admin identity, skipped Turnstile).
 * Anything else - including a missing or misspelt ENVIRONMENT - is treated as production, so a configuration
 * mistake fails closed instead of open.
 */
const NON_PRODUCTION = new Set(["sandbox", "development", "dev", "test", "local"]);

export function isNonProduction(environment: string | undefined): boolean {
  return NON_PRODUCTION.has((environment ?? "").trim().toLowerCase());
}
