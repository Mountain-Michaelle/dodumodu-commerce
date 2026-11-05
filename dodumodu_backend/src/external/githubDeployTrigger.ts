import type { Env } from "../env";

/**
 * Asks GitHub Actions to run the storefront-deploy workflow via repository_dispatch.
 *
 * The production Worker is a plain Worker, so it cannot run `wrangler deploy` itself.
 * Something outside the Worker must perform the build + deploy; GitHub Actions already
 * has that pipeline (deploy-storefront.yml). This module is the Publish → CI trigger.
 *
 * Never throws: a dispatch failure is reported as `status: "failed"` so the publish
 * (snapshot) still succeeds and the admin can retry via /products/:id/redeploy.
 *
 * A successful dispatch means only that GitHub accepted the event — NOT that deployment
 * succeeded, NOT that the build ran, and NOT that the page is live.
 */
export type DispatchResult = {
  status: "pending" | "triggered" | "failed";
  error: string | null;
  httpStatus: number | null;
  durationMs: number;
  retryable: boolean;
};

const DISPATCH_TIMEOUT_MS = 10_000;
const REPO = "Mountain-Michaelle/dodumodu-commerce";
const EVENT_TYPE = "storefront-deploy";

export async function triggerGitHubDispatch(
  env: Env,
  context?: { publishId?: number | string; productId?: number | string; buildId?: number | string },
): Promise<DispatchResult> {
  const token = (env.GITHUB_DEPLOY_TOKEN ?? "").trim();

  if (token === "") {
    // Explicit unconfigured state: the snapshot still publishes, but no deploy can be
    // triggered until the token is set. retryable: true so the admin can retry after
    // configuring the secret, rather than being stuck on a dead "pending".
    return {
      status: "pending",
      error: "GITHUB_DEPLOY_TOKEN is not configured — deploy will not be triggered until set",
      httpStatus: null,
      durationMs: 0,
      retryable: true,
    };
  }

  const started = Date.now();
  const finish = (result: Omit<DispatchResult, "durationMs">): DispatchResult => ({
    ...result,
    durationMs: Date.now() - started,
  });

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: "POST",
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: EVENT_TYPE,
        client_payload: {
          source: "admin-publish",
          publish_id: context?.publishId ?? null,
          product_id: context?.productId ?? null,
          build_id: context?.buildId ?? null,
        },
      }),
    });

    if (!res.ok) {
      return finish({
        status: "failed",
        error: `GitHub dispatch rejected (HTTP ${res.status})`,
        httpStatus: res.status,
        retryable: true,
      });
    }

    return finish({ status: "triggered", error: null, httpStatus: res.status, retryable: true });
  } catch (err) {
    const reason = err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : String(err);
    console.warn(
      JSON.stringify({ event: "github_dispatch_failed", reason, durationMs: Date.now() - started })
    );
    return finish({
      status: "failed",
      error: `Could not reach GitHub to trigger the build runner: ${reason}`,
      httpStatus: null,
      retryable: true,
    });
  }
}