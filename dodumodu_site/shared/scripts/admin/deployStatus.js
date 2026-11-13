import { el, mount } from "./dom.js";

/**
 * Rendering the four deployment states, and nothing else.
 *
 * Kept apart from products.js because it needs no state of its own: it takes the
 * OBSERVED status and renders it. That separation is the point - the panel must be
 * impossible to feed a "live" it inferred for itself, so the only way to render one
 * is to pass in a status that came from GET /products/:id/status.
 *
 * The four states, and what each is evidence of:
 *
 *   PUBLISHED  the immutable snapshot exists
 *   DEPLOYING  a rebuild was requested; the storefront has not been re-verified yet
 *   FAILED     the rebuild request did not reach Cloudflare; the snapshot is safe
 *   LIVE       the public page was fetched and its version marker matches
 *
 * LIVE is the only one backed by evidence, and it is the only one that requires a
 * network round trip to claim.
 */

const STATE_ICON = { LIVE: "✓", DEPLOYING: "⟳", FAILED: "✕", PUBLISHED: "•" };

export function stateLabel(state) {
  switch (state) {
    case "LIVE": return "LIVE ON STOREFRONT";
    case "DEPLOYING": return "REBUILDING STOREFRONT";
    case "FAILED": return "STOREFRONT DEPLOYMENT FAILED";
    default: return "PUBLISHED";
  }
}

/**
 * The second line under the state.
 *
 * It never guesses at a duration. "Live in 1-3 minutes" is a claim nobody has
 * measured, and when it turns out to be wrong it is the only thing an operator
 * remembers about the panel.
 */
function stepLabel(status, key) {
  return (status.build?.steps || []).find((s) => s.step === key)?.label || key;
}

const STEP_ICON = { ok: "✓", running: "⟳", failed: "✕", skipped: "–" };

/** The live step list of the build behind this publish. */
function renderSteps(build) {
  if (!build || !build.steps || build.steps.length === 0) return null;
  return el("ol", { class: "deploy-steps" }, build.steps.map((s) => el("li", { class: `deploy-step is-${s.status}` },
    el("span", { class: "deploy-step-icon", "aria-hidden": "true", text: STEP_ICON[s.status] || "•" }),
    el("span", { class: "deploy-step-label", text: s.label || s.step }),
    s.status === "failed" && s.message ? el("pre", { class: "deploy-step-message", text: s.message }) : null)));
}

export function stateDetail(status) {
  if (status.state === "LIVE") {
    return `Verified on the public page${status.checkedAt
      ? ` at ${new Date(status.checkedAt).toLocaleTimeString()}` : ""}.`;
  }
  if (status.state === "DEPLOYING" && status.build?.currentStep) {
    const cur = (status.build.steps || []).find((s) => s.step === status.build.currentStep);
    return `Now: ${cur?.label || status.build.currentStep}. The storefront is still serving the previous version.`;
  }
  if (status.state === "DEPLOYING") return "Published. The storefront is still serving the previous version.";
  if (status.state === "FAILED") {
    const where = status.build?.failedStep ? ` at "${stepLabel(status, status.build.failedStep)}"` : "";
    return `The build failed${where}. The snapshot is safe and the storefront is unchanged.`;
  }
  if (!status.publishVersion) return "This product has never been published.";
  if (status.verificationReason === "unconfigured") {
    return "Published. Live status cannot be checked until SITE_URL is configured.";
  }
  if (status.verificationReason === "unreachable") {
    return "Published. The public storefront could not be reached to verify it.";
  }
  return "Published, but no build is running. Use Retry Deployment to start one.";
}

export function renderDeploymentStatus(status, { onRetry } = {}) {
  const publishRow = el("div", { class: "deploy-version" },
    el("span", { class: "deploy-label", text: "Published version" }),
    el("code", { class: "reference", text: status.publishVersion ?? "—" }));

  // The "currently live" row appears whenever the storefront reports a version.
  // It is styled as stale only when the two DIFFER - which is the case an operator
  // needs spelled out: a rebuild in flight while an older version is still served.
  const differs = Boolean(status.liveVersion) && status.liveVersion !== status.publishVersion;
  const liveRow = !status.liveVersion ? null : el("div", { class: "deploy-version" },
    el("span", { class: "deploy-label", text: "Currently live" }),
    el("code", { class: differs ? "reference is-stale" : "reference", text: status.liveVersion }));

  const banner = el("div", { class: `deploy-state is-${String(status.state).toLowerCase()}` },
    el("span", { class: "deploy-icon", "aria-hidden": "true", text: STATE_ICON[status.state] ?? "•" }),
    el("span", { class: "deploy-text" },
      el("strong", { text: stateLabel(status.state) }),
      el("span", { class: "muted", text: stateDetail(status) })));

  const actions = el("div", { class: "deploy-actions" },
    // Always offered when the storefront URL is known: reading the real page is how
    // an operator confirms any of this independently of the panel.
    status.storefrontUrl
      ? el("a", {
        class: "button", href: status.storefrontUrl, target: "_blank", rel: "noopener noreferrer",
        text: "View Storefront",
      })
      : null,
    status.build?.runUrl
      ? el("a", { class: "button", href: status.build.runUrl, target: "_blank", rel: "noopener noreferrer", text: "View GitHub run" })
      : null,
    // Offered whenever nothing is running and the page is not live: a failed build, or a publish whose build
    // never started. A build in progress or a live page has nothing to retry.
    (status.state === "FAILED" || (status.state === "PUBLISHED" && status.publishRef && status.build?.state !== "running")) && onRetry
      ? el("button", {
        class: "button button-primary", type: "button", text: "Retry Deployment",
        onclick: onRetry,
      })
      : null);

  return el("div", { class: "deploy-panel" },
    el("h3", { class: "detail-heading", text: "Storefront" }),
    banner,
    renderSteps(status.build),
    status.deployError && status.state !== "LIVE"
      ? el("div", { class: "deploy-error" },
        el("strong", { text: status.build?.failedStep ? `Why it failed (${stepLabel(status, status.build.failedStep)})` : "Why it failed" }),
        el("pre", { class: "reference", text:
          `${status.deployError}${status.deployHttpStatus ? `\nHTTP ${status.deployHttpStatus}` : ""}`
          + `${status.deployAttempts ? `\nAttempts: ${status.deployAttempts}` : ""}`
          + `${status.deployAttemptedAt ? `\nAt: ${new Date(status.deployAttemptedAt).toLocaleString()}` : ""}` }))
      : null,
    el("div", { class: "deploy-versions" }, publishRow, liveRow),
    actions);
}

/** Mounts the panel, or an explicit reason it could not be produced. */
export function mountDeploymentStatus(host, status, options) {
  mount(host, renderDeploymentStatus(status, options));
}

export function mountStatusUnavailable(host, onRetry) {
  mount(host, el("div", { class: "deploy-panel" },
    el("p", { class: "muted", text: "Could not check the storefront status." }),
    onRetry
      ? el("button", { class: "button", type: "button", text: "Try again", onclick: onRetry })
      : null));
}