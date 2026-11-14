import type { Env } from "../env";
import { isUsableSecret } from "../shared/secureEqual";

/**
 * What publishing needs from the Worker's own environment, checked when Publish or Retry is pressed - never at build
 * time. A missing value is reported on the product page with the exact command to fix it.
 *   GITHUB_DEPLOY_TOKEN   lets the Worker start the workflow
 *   DEPLOY_TRIGGER_SECRET lets the workflow report back and fetch snapshots (/ci)
 *   SITE_URL              where the Worker reads the live storefront to confirm a publish
 */
export function missingDeployConfig(env: Env): string[] {
  const missing: string[] = [];
  if (!isUsableSecret(env.GITHUB_DEPLOY_TOKEN)) missing.push("GITHUB_DEPLOY_TOKEN");
  if (!isUsableSecret(env.DEPLOY_TRIGGER_SECRET)) missing.push("DEPLOY_TRIGGER_SECRET");
  if (!(env.SITE_URL ?? "").trim()) missing.push("SITE_URL");
  return missing;
}

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
/** One quick retry for a transient blip (network error, 429, 5xx). Never after a timeout. */
const RETRY_DELAY_MS = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isTransient = (status: number) => status === 429 || status >= 500;

export async function triggerGitHubDispatch(
  env: Env,
  context?: {
    publishId?: number | string; publishRef?: string; productId?: number | string; buildId?: number | string;
  },
): Promise<DispatchResult> {
  const token = (env.GITHUB_DEPLOY_TOKEN ?? "").trim();
  const missing = missingDeployConfig(env);

  if (missing.length > 0) {
    // Explicit unconfigured state: the snapshot still publishes, but no deploy can be
    // triggered until the token is set. retryable: true so the admin can retry after
    // configuring the secret, rather than being stuck on a dead "pending".
    return {
      status: "pending",
      error: `Not configured on the Worker: ${missing.join(", ")}. The snapshot is saved; nothing was deployed. `
        + `Set each with "wrangler secret put <NAME>" (SITE_URL is a plain variable), then press Retry.`,
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

  const send = () => fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: "POST",
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub rejects API requests that carry no User-Agent with a 403. curl and
        // browsers add one themselves; a Worker's fetch() does not.
        "User-Agent": "dodumodu-backend-deploy-trigger",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: EVENT_TYPE,
        client_payload: {
          source: "admin-publish",
          publish_id: context?.publishId ?? null,
          publish_ref: context?.publishRef ?? null,
          product_id: context?.productId ?? null,
          build_id: context?.buildId ?? null,
        },
      }),
    });

  try {
    let res: Response;
    try {
      res = await send();
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") throw err; // already waited 10s
      await sleep(RETRY_DELAY_MS);
      res = await send();
    }
    if (!res.ok && isTransient(res.status)) {
      await sleep(RETRY_DELAY_MS);
      res = await send();
    }

    if (!res.ok) {
      // GitHub says WHY in the body (bad token, missing permission, SSO, no User-Agent).
      // Surface it, capped; the token is never echoed back by GitHub.
      const detail = await res.text().then((t) => {
        try { return String((JSON.parse(t) as { message?: unknown }).message ?? "").slice(0, 300); }
        catch { return t.slice(0, 300); }
      }).catch(() => "");
      console.warn(JSON.stringify({
        event: "github_dispatch_rejected", httpStatus: res.status, detail,
        durationMs: Date.now() - started,
      }));
      return finish({
        status: "failed",
        error: `GitHub dispatch rejected (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
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