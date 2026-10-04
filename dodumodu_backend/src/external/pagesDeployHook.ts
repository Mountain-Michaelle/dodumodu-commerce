import type { Env } from "../env";

/**
 * Firing a Cloudflare Pages deploy hook.
 *
 * This is an EXTERNAL SIDE EFFECT and is treated as one. Every failure mode here -
 * timeout, network error, non-2xx, an unparseable response - resolves to
 * `{ ok: false }`. Nothing in this file throws, because the caller is a publish
 * operation that has already succeeded and must not be undone by a side effect it
 * does not control.
 *
 * The distinction that matters, and which is easy to blur:
 *
 *   publish succeeded   = the immutable snapshot is in product_publishes
 *   deployment triggered = this request was sent and Cloudflare accepted it
 *
 * A deploy hook returning 200 does NOT mean a build started, and certainly does
 * not mean one finished. It means the request was received. "triggered" is
 * therefore the honest word for it, and the snapshot is what "published" means.
 */

export type DeploymentStatus = "pending" | "triggered" | "failed" | "deployed";

export type DeploymentResult = {
  status: DeploymentStatus;
  /** Null when the hook is not configured, which is the normal local case. */
  error: string | null;
  httpStatus: number | null;
  durationMs: number;
  /** False when there is nothing to retry against - i.e. no hook is configured. */
  retryable: boolean;
};

/**
 * How long to wait before giving up.
 *
 * Ten seconds is a balance rather than a guess: long enough that a cold Cloudflare
 * edge is comfortably covered, short enough that an admin watching a spinner does
 * not assume the console has hung. A retry is always available afterwards, so a
 * timeout here costs a click and nothing else.
 */
const HOOK_TIMEOUT_MS = 10_000;

/**
 * Fires the configured Pages deploy hook.
 *
 * Returns "triggered" when Cloudflare accepted the request, and "failed" with a
 * reason when it did not. Never throws.
 */
export async function triggerPagesDeploy(env: Env): Promise<DeploymentResult> {
  const url = (env.PAGES_DEPLOY_HOOK ?? "").trim();

  if (url === "") {
    // Not an error. There is no deploy hook in local development, and pretending
    // otherwise would make every local publish look broken. The caller shows
    // "published" and skips the rebuild message entirely.
    return {
      status: "pending",
      error: null,
      httpStatus: null,
      durationMs: 0,
      retryable: false,
    };
  }

  const started = Date.now();
  const finish = (result: Omit<DeploymentResult, "durationMs">): DeploymentResult => ({
    ...result,
    durationMs: Date.now() - started,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      // An AbortSignal rather than a manual timer: one mechanism, and it aborts the
      // body read too, not just the headers.
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      // Cloudflare ignores the body, but sending one keeps the request well-formed
      // for anything sitting in front of it.
      body: JSON.stringify({ source: "admin-publish" }),
    });

    if (!res.ok) {
      return finish({
        status: "failed",
        error: `Pages rejected the deploy hook (HTTP ${res.status})`,
        httpStatus: res.status,
        retryable: true,
      });
    }

    return finish({ status: "triggered", error: null, httpStatus: res.status, retryable: true });
  } catch (err) {
    // One message for every failure mode, because from the operator's side they
    // are the same problem: Cloudflare did not answer. The distinguishing detail
    // goes in the log, where it is useful, rather than in the UI, where it is not.
    const reason = err instanceof Error ? err.name === "TimeoutError" ? "timed out" : err.message : String(err);
    console.warn(JSON.stringify({
      event: "deploy_hook_failed",
      reason,
      durationMs: Date.now() - started,
    }));
    return finish({
      status: "failed",
      error: `Could not reach the Pages deploy hook: ${reason}`,
      httpStatus: null,
      retryable: true,
    });
  }
}