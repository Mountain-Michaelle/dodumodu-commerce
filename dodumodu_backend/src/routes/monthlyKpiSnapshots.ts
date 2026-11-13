import { secretMatches } from "../shared/secureEqual";
import { Hono } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { monthlyKpiService } from "../services/monthlyKpiService";

export const monthlyKpiSnapshotsRoute = new Hono<{ Bindings: Env }>();

monthlyKpiSnapshotsRoute.post("/internal/monthly-kpi-snapshots/close", async (c) => {
  const secret = c.req.header("x-cron-secret");
  if (!secretMatches(secret, c.env.RECONCILE_CRON_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const snapshot = await monthlyKpiService.closePreviousMonth(
    createDb(c.env.DATABASE_URL),
  );
  return c.json({
    month: snapshot.month,
    source: snapshot.source,
    takenAt: snapshot.takenAt,
  });
});
