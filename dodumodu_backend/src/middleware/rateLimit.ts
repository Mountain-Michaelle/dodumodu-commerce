import type { Context, Next } from "hono";
import type { Env } from "../env";
import { ACCESS_EMAIL_HEADER } from "../auth/adminAuth";



// REMOVED: the per-phone KV order limiter that used to live here.
//
// It keyed on the RAW phone string, so "08012345678" and "+2348012345678" were
// two different buckets and the limit was bypassable by reformatting. It read and
// wrote the counter separately, so concurrent bursts lost increments - and KV
// allows only one write per second per key, so it lost them exactly when they
// mattered. It also counted RETRIES, so a customer whose network dropped mid
// checkout could exhaust their own limit.
//
// Its replacement is orderGuard (src/middleware/orderGuard.ts): idempotency first,
// canonical phone identity, and atomic counters. Deleting it here is deliberate -
// two limiters on one endpoint is how a block arrives from the wrong one.

// Simple fixed-window counter in KV. Good enough for V1 — don't build anything
// elaborate. Shared mobile networks put many legitimate customers behind one
// IP, so these limits (env-configurable) will likely need tuning after real traffic.
async function checkAndIncrement(kv: KVNamespace, key: string, limit: number, windowSeconds: number) {
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= limit) return false;
  await kv.put(key, String(count + 1), { expirationTtl: windowSeconds });
  return true;
}



/** General API rate limit — per IP. */
export async function apiRateLimit(c: Context<{ Bindings: Env }>, next: Next) {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const limit = parseInt(c.env.RATE_LIMIT_API_PER_MINUTE, 10);
  const ok = await checkAndIncrement(c.env.RATE_LIMIT_KV, `api:${ip}`, limit, 60);
  if (!ok) return c.json({ error: "Too many requests" }, 429);
  await next();
}

/**
 * Who to charge this request to.
 *
 * The operator email Cloudflare Access vouched for, falling back to the IP.
 * It reads the SAME header resolvePrincipal does rather than a Context variable, so
 * it can run on requests that never reached the authorization middleware - and so
 * adding it did not require threading a new variable through every admin sub-router's
 * type signature. The header is still only a KEY for a counter here: an unauthenticated
 * caller can forge it, but forging it just moves them into another bucket, and the
 * request itself is still refused downstream by resolvePrincipal.
 */
function adminIdentity(c: Context<{ Bindings: Env }>): string {
  return c.req.header(ACCESS_EMAIL_HEADER)
    ?? c.req.header("cf-connecting-ip")
    ?? "unknown";
}

/**
 * The admin limiter, which is a DIFFERENT limiter from the customer one.
 *
 * Why it cannot be the same: apiRateLimit keys on `api:${ip}`, which is also the
 * bucket for /page-data, /published and /create-order. Putting the admin console in
 * that bucket means an operator's own browsing competes with customer traffic for one
 * budget of RATE_LIMIT_API_PER_MINUTE (20/min by default) - and locally, where every
 * request is forced to 127.0.0.1, there is only ever ONE bucket. The symptom was a
 * console that locked itself out after about seven searches.
 *
 * Two things follow from this, and both are deliberate:
 *
 *  - It keys on the OPERATOR EMAIL, not the IP. An IP is the wrong identity for a
 *    person: it changes between networks, and a shared office or phone hotspot would
 *    pool several operators into one budget.
 *
 *  - The ceiling is high. This is a limit against a stolen session or a runaway
 *    script, not against a person using the console. Reading a list is cheap; the
 *    expensive endpoints are the WRITES, limited separately below.
 */
export async function adminRateLimit(c: Context<{ Bindings: Env }>, next: Next) {
  const identity = adminIdentity(c);
  const limit = parseInt(c.env.RATE_LIMIT_ADMIN_PER_MINUTE, 10) || 600;
  const ok = await checkAndIncrement(c.env.RATE_LIMIT_KV, `admin:read:${identity}`, limit, 60);
  if (!ok) {
    return c.json({
      error: {
        code: "RATE_LIMITED",
        message: "You are going faster than the console allows. Wait a moment and try again.",
      },
    }, 429);
  }
  await next();
}

/**
 * A much tighter limit on the endpoints that CHANGE something.
 *
 * This is the real abuse surface: marking orders paid, running a bulk action,
 * uploading. Reading a table a hundred times a minute is a slow console; marking
 * four hundred orders paid in a minute is not.
 */
export async function adminWriteRateLimit(c: Context<{ Bindings: Env }>, next: Next) {
  const identity = adminIdentity(c);
  const limit = parseInt(c.env.RATE_LIMIT_ADMIN_WRITES_PER_MINUTE, 10) || 60;
  const ok = await checkAndIncrement(c.env.RATE_LIMIT_KV, `admin:write:${identity}`, limit, 60);
  if (!ok) {
    return c.json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many changes in a short time. Wait a minute and try again.",
      },
    }, 429);
  }
  await next();
}
