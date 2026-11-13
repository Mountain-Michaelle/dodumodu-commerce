import { test } from "node:test";
import assert from "node:assert/strict";
import { deployProgress, NO_BUILD } from "./deployProgress";
import { siteBuildsRepo } from "../data/siteBuildsRepo";
import { STALL_MS } from "./publishService";

/* The panel must never say "deploying" about a build that is not going to finish. */

const PUBLISH = { id: 4, publishRef: "pub_aaaaaaaaaaaaaaaaaaaa" };

function stub(build: Record<string, unknown> | null, events: Record<string, unknown>[] = []) {
  const failed: unknown[][] = [];
  const saved = { l: siteBuildsRepo.latestForPublish, e: siteBuildsRepo.events, f: siteBuildsRepo.markFailed };
  siteBuildsRepo.latestForPublish = async () => build as never;
  siteBuildsRepo.events = async () => events as never;
  siteBuildsRepo.markFailed = async (_d, ...args) => { failed.push(args); return null as never; };
  return { failed, restore: () => { Object.assign(siteBuildsRepo, { latestForPublish: saved.l, events: saved.e, markFailed: saved.f }); } };
}
const build = (over: Record<string, unknown>) => ({
  buildId: "b1", status: "triggered", verificationError: null, failedStep: null, currentStep: "render",
  runUrl: "https://github.com/x/y/actions/runs/1", lastEventAt: new Date(), ...over,
});
const ev = (id: number, step: string, status: string, message: string | null = null, label = step) =>
  ({ id, buildId: "b1", step, label, status, message, createdAt: new Date() });

test("no build yet", async () => {
  const s = stub(null);
  try { assert.deepEqual(await deployProgress({} as never, PUBLISH), NO_BUILD); } finally { s.restore(); }
});

test("a running build shows its steps, the latest state of each, and the current step", async () => {
  const s = stub(build({}), [ev(1, "install", "running"), ev(2, "install", "ok"), ev(3, "render", "running", null, "Rendering")]);
  try {
    const p = await deployProgress({} as never, PUBLISH);
    assert.equal(p.state, "running");
    assert.equal(p.currentStep, "render");
    assert.deepEqual(p.steps.map((x) => [x.step, x.status]), [["install", "ok"], ["render", "running"]]);
    assert.equal(p.runUrl, "https://github.com/x/y/actions/runs/1");
  } finally { s.restore(); }
});

test("a failed build names the step and carries the error", async () => {
  const s = stub(build({ status: "failed", verificationError: "permission denied", failedStep: "render" }), [ev(1, "render", "failed", "permission denied")]);
  try {
    const p = await deployProgress({} as never, PUBLISH);
    assert.equal(p.state, "failed");
    assert.equal(p.failedStep, "render");
    assert.equal(p.error, "permission denied");
    assert.equal(p.currentStep, null);
  } finally { s.restore(); }
});

test("a build that has gone silent is reported failed and recorded as failed, not left deploying", async () => {
  const old = new Date(Date.now() - STALL_MS - 60_000);
  const s = stub(build({ lastEventAt: old, currentStep: "deploy" }), [ev(1, "deploy", "running")]);
  try {
    const p = await deployProgress({} as never, PUBLISH);
    assert.equal(p.state, "failed");
    assert.equal(p.stalled, true);
    assert.equal(p.failedStep, "deploy");
    assert.match(p.error ?? "", /No progress/);
    assert.equal(s.failed.length, 1, "the failure is persisted so history agrees with the panel");
  } finally { s.restore(); }
});

test("a verified build is verified", async () => {
  const s = stub(build({ status: "verified", currentStep: null }), [ev(1, "verify", "ok")]);
  try { assert.equal((await deployProgress({} as never, PUBLISH)).state, "verified"); } finally { s.restore(); }
});
