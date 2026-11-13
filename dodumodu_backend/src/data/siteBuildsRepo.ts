import { desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { deployEvents, siteBuilds } from "../schema";

export type IntendedPublication = { slug: string; publishId: number; publishRef: string };

// The site_builds table tracks each storefront build (one GitHub Actions run) and its intended
// publication set, enabling publication-consistency revalidation before a stale build can overwrite a
// newer release. deploy_events holds the step-by-step log the admin panel shows while it runs.
//
// Statuses:  queued -> triggered -> deployed -> verified   (or failed at any point)
//   queued     the Worker asked GitHub to run; the run has not reported in yet
//   triggered  the run started and recorded what it is building
//   deployed   wrangler deploy finished; the storefront has not been re-read yet
export const IN_FLIGHT = ["queued", "triggered", "deployed"] as const;

export const siteBuildsRepo = {
  async record(
    db: Db,
    input: {
      buildId: string;
      intendedPublications: IntendedPublication[];
      triggeredBy: string;
      triggerPublishId?: number | null;
      runUrl?: string | null;
      status?: "queued" | "triggered";
    },
  ) {
    const [row] = await db
      .insert(siteBuilds)
      .values({
        buildId: input.buildId,
        intendedPublications: input.intendedPublications,
        triggeredBy: input.triggeredBy,
        triggerPublishId: input.triggerPublishId ?? null,
        runUrl: input.runUrl ?? null,
        status: input.status ?? "triggered",
        lastEventAt: new Date(),
      })
      .returning();
    return row;
  },

  /** The run reported in: record what it will build and where its log lives. */
  async markStarted(
    db: Db, buildId: string,
    input: { intendedPublications?: IntendedPublication[]; runUrl?: string | null },
  ) {
    const set: Partial<typeof siteBuilds.$inferInsert> = { status: "triggered", lastEventAt: new Date() };
    if (input.intendedPublications) set.intendedPublications = input.intendedPublications;
    if (input.runUrl) set.runUrl = input.runUrl;
    const [row] = await db.update(siteBuilds).set(set).where(eq(siteBuilds.buildId, buildId)).returning();
    return row ?? null;
  },

  async markDeployed(db: Db, buildId: string) {
    const [row] = await db.update(siteBuilds)
      .set({ status: "deployed", lastEventAt: new Date() })
      .where(eq(siteBuilds.buildId, buildId)).returning();
    return row ?? null;
  },

  async markVerified(db: Db, buildId: string) {
    const [row] = await db.update(siteBuilds)
      .set({ status: "verified", verifiedAt: new Date(), lastEventAt: new Date(), currentStep: null })
      .where(eq(siteBuilds.buildId, buildId)).returning();
    return row ?? null;
  },

  async markFailed(db: Db, buildId: string, error: string | null, failedStep?: string | null) {
    const [row] = await db.update(siteBuilds)
      .set({ status: "failed", verificationError: error, failedStep: failedStep ?? null, lastEventAt: new Date() })
      .where(eq(siteBuilds.buildId, buildId)).returning();
    return row ?? null;
  },

  async setCurrentStep(db: Db, buildId: string, step: string | null) {
    await db.update(siteBuilds).set({ currentStep: step, lastEventAt: new Date() })
      .where(eq(siteBuilds.buildId, buildId));
  },

  async getByBuildId(db: Db, buildId: string) {
    const [row] = await db.select().from(siteBuilds).where(eq(siteBuilds.buildId, buildId)).limit(1);
    return row ?? null;
  },

  async getLatest(db: Db, limit = 10) {
    const rows = await db.select().from(siteBuilds);
    // A single row needs no ordering (and the test fake database does not implement orderBy).
    if (rows.length <= 1) return rows;
    return db.select().from(siteBuilds).orderBy(desc(siteBuilds.triggeredAt), desc(siteBuilds.id)).limit(limit);
  },

  /** The newest build that was triggered for, or intends to ship, this publish. */
  async latestForPublish(db: Db, publishId: number, publishRef: string) {
    const recent = await siteBuildsRepo.getLatest(db, 25);
    return recent.find((b) =>
      b.triggerPublishId === publishId
      || (b.intendedPublications as IntendedPublication[]).some((p) => p.publishRef === publishRef),
    ) ?? null;
  },

  async addEvent(
    db: Db,
    input: { buildId: string; step: string; label?: string; status: string; message?: string | null },
  ) {
    const [row] = await db.insert(deployEvents).values({
      buildId: input.buildId, step: input.step, label: input.label ?? "",
      status: input.status, message: input.message ?? null,
    }).returning();
    return row;
  },

  async events(db: Db, buildId: string, limit = 200) {
    const rows = await db.select().from(deployEvents).where(eq(deployEvents.buildId, buildId));
    return rows.sort((a, b) => a.id - b.id).slice(-limit);
  },
};
