import { desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { siteBuilds } from "../schema";

// The site_builds table tracks each storefront build and its intended
// publication set, enabling publication-consistency revalidation before a
// stale build can overwrite a newer release.
export const siteBuildsRepo = {
  async record(
    db: Db,
    input: {
      buildId: string;
      intendedPublications: { slug: string; publishId: number }[];
      triggeredBy: string;
    },
  ) {
    const [row] = await db
      .insert(siteBuilds)
      .values({
        buildId: input.buildId,
        intendedPublications: input.intendedPublications,
        triggeredBy: input.triggeredBy,
        status: "triggered",
      })
      .returning();
    return row;
  },

  async markDeployed(db: Db, buildId: string) {
    const [row] = await db
      .update(siteBuilds)
      .set({ status: "deployed" })
      .where(eq(siteBuilds.buildId, buildId))
      .returning();
    return row ?? null;
  },

  async markVerified(db: Db, buildId: string) {
    const [row] = await db
      .update(siteBuilds)
      .set({ status: "verified", verifiedAt: new Date() })
      .where(eq(siteBuilds.buildId, buildId))
      .returning();
    return row ?? null;
  },

  async markFailed(db: Db, buildId: string, error: string | null) {
    const [row] = await db
      .update(siteBuilds)
      .set({ status: "failed", verificationError: error })
      .where(eq(siteBuilds.buildId, buildId))
      .returning();
    return row ?? null;
  },

  async getByBuildId(db: Db, buildId: string) {
    const [row] = await db
      .select()
      .from(siteBuilds)
      .where(eq(siteBuilds.buildId, buildId))
      .limit(1);
    return row ?? null;
  },

  async getLatest(db: Db, limit = 10) {
    return db
      .select()
      .from(siteBuilds)
      .orderBy(desc(siteBuilds.triggeredAt))
      .limit(limit);
  },
};