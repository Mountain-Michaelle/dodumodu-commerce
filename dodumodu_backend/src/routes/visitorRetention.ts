import { Hono } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { visitorAnalyticsService } from "../services/visitorAnalyticsService";

/**
 * Scheduled pruning of visitor-day records older than the 13-month retention
 * cutoff. Same internal-cron authentication pattern as the KPI snapshot close
 * route: a shared secret in the x-cron-secret header, never customer-facing.
 *
 * Pruning is idempotent and batched (see pruneExpired): a run with nothing left
 * to delete reports deleted=0 and morePending=false. Closed-year snapshots are
 * captured before deletion, so distinct yearly counts survive pruning.
 */
export const visitorRetentionRoute = new Hono<{ Bindings: Env }>();

visitorRetentionRoute.post("/internal/visitor-retention/prune", async (c) => {
  const secret = c.req.header("x-cron-secret");
  if (!c.env.RECONCILE_CRON_SECRET || secret !== c.env.RECONCILE_CRON_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const result = await visitorAnalyticsService.pruneExpired(createDb(c.env.DATABASE_URL));
  return c.json({
    cutoff: result.cutoff,
    deleted: result.deleted,
    morePending: result.morePending,
  });
});
