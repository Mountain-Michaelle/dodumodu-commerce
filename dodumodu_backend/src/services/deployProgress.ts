import type { Db } from "../db";
import { siteBuildsRepo, IN_FLIGHT } from "../data/siteBuildsRepo";
import { STALL_MS } from "./publishService";

/** A queued build whose run never reported in. GitHub starts a run in seconds, so this is long enough to be sure. */
export const NEVER_STARTED_MS = 5 * 60 * 1000;

// What the admin panel shows about the build behind a publish: which step it is on, which steps passed,
// and - if it broke - exactly which step and why.
//
// The honest edge case this exists for: a run that is cancelled, or dies before it can report, would leave
// its build "in progress" forever. A build that has said nothing for STALL_MS is therefore reported as
// failed (and recorded as failed), instead of the panel saying "deploying" for ever.

export type StepState = { step: string; label: string; status: "running" | "ok" | "failed" | "skipped"; message: string | null; at: string };

export type BuildProgress = {
  buildId: string | null;
  /** none: nothing was ever queued. running: in flight. verified / failed: terminal. */
  state: "none" | "running" | "verified" | "failed";
  currentStep: string | null;
  failedStep: string | null;
  error: string | null;
  stalled: boolean;
  runUrl: string | null;
  steps: StepState[];
};

export const NO_BUILD: BuildProgress = {
  buildId: null, state: "none", currentStep: null, failedStep: null, error: null, stalled: false, runUrl: null, steps: [],
};

export async function deployProgress(
  db: Db, publish: { id: number; publishRef: string }, now = Date.now(),
): Promise<BuildProgress> {
  const build = await siteBuildsRepo.latestForPublish(db, publish.id, publish.publishRef);
  if (!build) return NO_BUILD;

  const events = await siteBuildsRepo.events(db, build.buildId);
  const order: string[] = [];
  const byStep = new Map<string, StepState>();
  for (const e of events) {
    if (!byStep.has(e.step)) order.push(e.step);
    const prev = byStep.get(e.step);
    byStep.set(e.step, {
      step: e.step,
      label: e.label || prev?.label || e.step,
      status: e.status as StepState["status"],
      message: e.message ?? prev?.message ?? null,
      at: new Date(e.createdAt).toISOString(),
    });
  }
  const steps = order.map((k) => byStep.get(k)!);

  let status = build.status;
  let error = build.verificationError ?? null;
  let failedStep = build.failedStep ?? null;
  let stalled = false;

  const idleMs = now - new Date(build.lastEventAt).getTime();
  const neverStarted = status === "queued" && idleMs > NEVER_STARTED_MS;
  if ((IN_FLIGHT as readonly string[]).includes(status) && (neverStarted || idleMs > STALL_MS)) {
    stalled = true;
    status = "failed";
    failedStep = neverStarted ? "workflow" : build.currentStep ?? "stalled";
    error = neverStarted
      ? "GitHub accepted the request, but the workflow run never reported back. Usually: the workflow file is not on the "
        + "default branch, or the repository's Actions secrets WORKER_URL and DEPLOY_TRIGGER_SECRET are missing or wrong "
        + "(a run cannot report without them). Open the repository's Actions tab for the run, fix that, then retry."
      : `No progress was reported for ${Math.round(STALL_MS / 60000)} minutes. The GitHub run was probably cancelled or crashed - check the run, then retry.`;
    await siteBuildsRepo.markFailed(db, build.buildId, error, failedStep);
  }

  const state: BuildProgress["state"] =
    status === "verified" ? "verified" : status === "failed" ? "failed" : "running";
  return {
    buildId: build.buildId, state,
    currentStep: state === "running" ? build.currentStep ?? null : null,
    failedStep: state === "failed" ? failedStep : null,
    error: state === "failed" ? error ?? "The build failed." : null,
    stalled, runUrl: build.runUrl ?? null, steps,
  };
}
