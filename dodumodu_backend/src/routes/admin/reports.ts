import { Hono } from "hono";
import type { Env } from "../../env";
import { createDb } from "../../db";
import { PERMISSIONS, type Principal } from "../../auth/adminAuth";
import { monthlyKpiService } from "../../services/monthlyKpiService";
import { requirePermissionOf } from "./helpers";

export const reportRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

reportRoutes.get("/monthly-kpis", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersRead);
  const rawMonths = c.req.query("months");
  const monthCount = rawMonths === undefined ? 12 : Number(rawMonths);
  if (!Number.isInteger(monthCount) || monthCount < 1 || monthCount > 24) {
    return c.json({
      error: { code: "VALIDATION_ERROR", message: "months must be an integer between 1 and 24" },
    }, 400);
  }

  const principal = c.get("principal");
  const reports = await monthlyKpiService.report(
    createDb(c.env.DATABASE_URL),
    monthCount,
    new Date(),
    principal.email,
  );
  return c.json({
    reports,
    collectionAvailable: false,
    collectionUnavailableReason:
      "Collected cash is not reported because no authoritative collection record and timestamp are persisted.",
    deliveryTimingNote:
      "Delivery activity uses status-history events where available; legacy delivered_at timestamps may be estimates from updated_at.",
  });
});
