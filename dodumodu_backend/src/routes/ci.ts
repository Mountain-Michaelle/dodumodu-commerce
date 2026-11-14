import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createDb } from "../db";
import { publishesRepo } from "../data/publishesRepo";
import { siteBuildsRepo, IN_FLIGHT, type IntendedPublication } from "../data/siteBuildsRepo";
import { isUsableSecret, secureEqual } from "../shared/secureEqual";
import { readBuildId, readPublishVersion } from "../services/storefrontStatus";
import { served } from "../services/servedStorefront";
import { logWarn, logError } from "../shared/logger";

// Everything the deploy pipeline (GitHub Actions) says to, and asks of, the Worker.
//
// Mounted at /ci, NOT under the admin namespace: the admin base path is deliberately configurable and secret
// in production, and a CI job that had to know it would break whenever it changed. These routes accept ONE
// credential - DEPLOY_TRIGGER_SECRET as a bearer token - and never a browser session or Access identity.
//
//   GET  /ci/snapshots                  what the storefront build must render (replaces a database login in CI)
//   POST /ci/builds/:id/start           the run reports in: what it builds, where its log is
//   POST /ci/builds/:id/events          one step of the run changed state (the admin panel shows these live)
//   POST /ci/builds/:id/pre-deploy      is this build still the newest? (409 = abort)
//   POST /ci/builds/:id/mark-deployed | mark-verified | mark-failed
export const ciRoute = new Hono<{ Bindings: Env }>();

ciRoute.use("*", async (c, next) => {
  const auth = c.req.header("authorization");
  const presented = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!isUsableSecret(c.env.DEPLOY_TRIGGER_SECRET) || !secureEqual(presented, c.env.DEPLOY_TRIGGER_SECRET)) {
    logWarn("ci_auth_rejected", { path: c.req.path, configured: isUsableSecret(c.env.DEPLOY_TRIGGER_SECRET) });
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

ciRoute.onError((err, c) => {
  logError("ci_unhandled_error", err);
  return c.json({ error: "Internal error" }, 500);
});

// The latest publish of every product. `?summary=1` leaves the payloads out: that is what the verifier uses to
// check nothing newer was published while the build ran.
ciRoute.get("/snapshots", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const rows = await publishesRepo.latestPerProduct(db);
  const summary = c.req.query("summary") === "1";
  return c.json({
    snapshots: rows.map((r) => {
      const p = r.payload as { product?: { id: number; slug: string; name: string; description: string; price: number } };
      return {
        productId: r.productId,
        slug: p.product?.slug,
        publishId: r.id,
        publishRef: r.publishRef,
        ...(summary ? {} : { name: p.product?.name, description: p.product?.description, price: p.product?.price, payload: r.payload }),
      };
    }),
  });
});

const buildIdSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/);
const intendedSchema = z.array(
  z.object({
    slug: z.string().min(1).max(120),
    publishId: z.number().int().positive(),
    publishRef: z.string().regex(/^pub_[0-9a-f]{20}$/),
  }),
).max(500);

// The run reports in. Idempotent: creates the build if the Worker never queued one (a manual workflow run),
// otherwise fills in the queued row. Kept at its historic name so existing runs keep working.
const startSchema = z.object({
  buildId: buildIdSchema,
  intendedPublications: intendedSchema.default([]),
  runUrl: z.string().url().max(500).optional(),
});

async function start(c: Context<{ Bindings: Env }>, body: unknown) {
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid request", fields: parsed.error.flatten().fieldErrors }, 400);
  const db = createDb(c.env.DATABASE_URL);
  const { buildId, intendedPublications, runUrl } = parsed.data;
  const existing = await siteBuildsRepo.getByBuildId(db, buildId);
  let record;
  if (existing) {
    // Never resurrect a build that already ended.
    if (existing.status === "verified" || existing.status === "failed") {
      return c.json({ buildId, status: existing.status }, 200);
    }
    record = await siteBuildsRepo.markStarted(db, buildId, { intendedPublications, runUrl });
  } else {
    record = await siteBuildsRepo.record(db, {
      buildId, intendedPublications, triggeredBy: "ci@deploy", runUrl, status: "triggered",
    });
  }
  console.log(JSON.stringify({
    event: "deploy_triggered", buildId, publicationCount: intendedPublications.length, created: !existing,
  }));
  return c.json({
    buildId, status: record?.status ?? "triggered",
    intendedPublications: record?.intendedPublications ?? intendedPublications,
    triggeredAt: record?.triggeredAt,
  }, existing ? 200 : 201);
}

ciRoute.post("/deploy-trigger", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  return start(c, body);
});
ciRoute.post("/builds/:buildId/start", async (c) => {
  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch { /* an empty body is fine */ }
  return start(c, { ...body, buildId: c.req.param("buildId") });
});

// One step of the run changed state. This is the live feed the admin panel polls. A step that FAILS also fails
// the build, so a broken step can never leave the panel saying "deploying" - and the message carries the error.
const eventSchema = z.object({
  step: z.string().min(1).max(60),
  label: z.string().max(120).optional(),
  status: z.enum(["running", "ok", "failed", "skipped"]),
  message: z.string().max(4000).optional(),
});
ciRoute.post("/builds/:buildId/events", async (c) => {
  const buildId = buildIdSchema.safeParse(c.req.param("buildId"));
  if (!buildId.success) return c.json({ error: "Invalid build id" }, 400);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid request", fields: parsed.error.flatten().fieldErrors }, 400);

  const db = createDb(c.env.DATABASE_URL);
  const existing = await siteBuildsRepo.getByBuildId(db, buildId.data);
  if (!existing) return c.json({ error: "Build not found" }, 404);
  // A finished build's log is closed: a late event cannot reopen it.
  if (existing.status === "verified" || existing.status === "failed") {
    return c.json({ buildId: buildId.data, status: existing.status, ignored: true }, 200);
  }
  const { step, label, status, message } = parsed.data;
  await siteBuildsRepo.addEvent(db, { buildId: buildId.data, step, label, status, message });
  if (status === "failed") {
    await siteBuildsRepo.markFailed(db, buildId.data, message ?? `${label ?? step} failed`, step);
  } else {
    await siteBuildsRepo.setCurrentStep(db, buildId.data, status === "running" ? step : existing.currentStep);
  }
  console.log(JSON.stringify({ event: "deploy_step", buildId: buildId.data, step, status }));
  return c.json({ buildId: buildId.data, status: status === "failed" ? "failed" : existing.status }, 200);
});

const paramBuild = (c: Context) => buildIdSchema.parse(c.req.param("buildId"));

/**
 * Reads each intended publication page from what this Worker is serving and checks both markers match the build.
 * (In-process: a Worker cannot fetch its own public URL - see services/servedStorefront.ts. The workflow has
 * already read the real public URL from outside before it asks for this.)
 */
function verifyPublicMarkers(intended: IntendedPublication[], buildId: string) {
  const failures: string[] = [];
  for (const { slug, publishRef } of intended) {
    const html = served.read(slug);
    if (html === null) { failures.push(`/${slug}/ is not in the storefront this Worker serves`); continue; }
    const liveVersion = readPublishVersion(html);
    const liveBuild = readBuildId(html);
    if (liveVersion !== publishRef) failures.push(`/${slug}/: live ${liveVersion ?? "(no marker)"} != expected ${publishRef}`);
    if (liveBuild !== buildId) failures.push(`/${slug}/: build ${liveBuild ?? "(no marker)"} != expected ${buildId}`);
  }
  return { ok: failures.length === 0, failures };
}

ciRoute.post("/builds/:buildId/mark-deployed", async (c) => {
  const buildId = paramBuild(c);
  const db = createDb(c.env.DATABASE_URL);
  const existing = await siteBuildsRepo.getByBuildId(db, buildId);
  if (!existing) return c.json({ error: "Build not found" }, 404);
  if (existing.status === "verified" || existing.status === "failed" || existing.status === "deployed") {
    return c.json({ buildId, status: existing.status }, 200);
  }
  if (!(IN_FLIGHT as readonly string[]).includes(existing.status)) {
    return c.json({ error: `Cannot deploy build in status ${existing.status}` }, 409);
  }
  await siteBuildsRepo.markDeployed(db, buildId);
  return c.json({ buildId, status: "deployed" }, 200);
});

// Verified only after the Worker ITSELF has read the public pages and found the markers: CI calling this
// endpoint is not evidence.
ciRoute.post("/builds/:buildId/mark-verified", async (c) => {
  const buildId = paramBuild(c);
  const db = createDb(c.env.DATABASE_URL);
  const existing = await siteBuildsRepo.getByBuildId(db, buildId);
  if (!existing) return c.json({ error: "Build not found" }, 404);
  if (existing.status === "verified") return c.json({ buildId, status: "verified" }, 200);
  if (existing.status === "failed") return c.json({ buildId, status: "failed" }, 200);
  if (!(IN_FLIGHT as readonly string[]).includes(existing.status)) {
    return c.json({ error: `Cannot verify build in status ${existing.status}` }, 409);
  }

  const latest = await siteBuildsRepo.getLatest(db, 1);
  if (latest.length > 0 && latest[0].buildId !== buildId) {
    return c.json({
      error: "Stale build",
      message: `A newer build (${latest[0].buildId}) is in progress; refusing to verify ${buildId}`,
    }, 409);
  }

  const verification = verifyPublicMarkers(existing.intendedPublications as IntendedPublication[], existing.buildId);
  if (!verification.ok) {
    const error = verification.failures.join("; ");
    await siteBuildsRepo.addEvent(db, { buildId, step: "verify", label: "Reading the live storefront", status: "failed", message: error });
    await siteBuildsRepo.markFailed(db, buildId, error, "verify");
    return c.json({ buildId, status: "failed", failures: verification.failures }, 200);
  }
  await siteBuildsRepo.addEvent(db, {
    buildId, step: "verify", label: "Reading the live storefront", status: "ok",
    message: "The public pages carry this build's markers.",
  });
  await siteBuildsRepo.markVerified(db, buildId);
  return c.json({ buildId, status: "verified" }, 200);
});

const failSchema = z.object({ error: z.string().max(4000).optional(), step: z.string().max(60).optional() });
ciRoute.post("/builds/:buildId/mark-failed", async (c) => {
  const buildId = paramBuild(c);
  const db = createDb(c.env.DATABASE_URL);
  const existing = await siteBuildsRepo.getByBuildId(db, buildId);
  if (!existing) return c.json({ error: "Build not found" }, 404);
  if (existing.status === "verified") return c.json({ buildId, status: "verified" }, 200);
  if (existing.status === "failed") return c.json({ buildId, status: "failed" }, 200);
  if (!(IN_FLIGHT as readonly string[]).includes(existing.status)) {
    return c.json({ error: `Cannot fail build in status ${existing.status}` }, 409);
  }
  let body: z.infer<typeof failSchema> = {};
  try { body = failSchema.parse(await c.req.json()); } catch { body = {}; }
  await siteBuildsRepo.markFailed(db, buildId, body.error ?? null, body.step ?? null);
  return c.json({ buildId, status: "failed" }, 200);
});

// Called before `wrangler deploy`: this build must still be the newest, and every product must still be at the
// publish it rendered. 409 aborts the run before it can overwrite something newer.
ciRoute.post("/builds/:buildId/pre-deploy", async (c) => {
  const buildId = paramBuild(c);
  const db = createDb(c.env.DATABASE_URL);
  const existing = await siteBuildsRepo.getByBuildId(db, buildId);
  if (!existing) return c.json({ error: "Build not found" }, 404);
  if (existing.status === "verified" || existing.status === "failed") {
    return c.json({ error: `Cannot deploy build in terminal status ${existing.status}` }, 409);
  }
  const latest = await siteBuildsRepo.getLatest(db, 1);
  if (latest.length > 0 && latest[0].buildId !== buildId) {
    return c.json({
      error: "Stale build",
      message: `A newer build (${latest[0].buildId}) has been triggered; refusing to pre-deploy ${buildId}`,
    }, 409);
  }
  const current = await publishesRepo.latestPerProduct(db);
  const intended = existing.intendedPublications as IntendedPublication[];
  if (intended.length > 0) {
    const live = new Map(current.map((r) => [(r.payload as { slug?: string }).slug, r.publishRef]));
    const moved = intended.find((p) => live.get(p.slug) !== p.publishRef);
    if (moved) {
      return c.json({ error: "Stale build", message: `/${moved.slug}/ was published again while this build ran` }, 409);
    }
  }
  return c.json({ buildId, status: existing.status, eligible: true }, 200);
});
