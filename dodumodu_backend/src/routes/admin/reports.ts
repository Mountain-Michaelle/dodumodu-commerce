import { Hono } from "hono";
import type { Env } from "../../env";
import { createDb } from "../../db";
import { PERMISSIONS, type Principal } from "../../auth/adminAuth";
import { monthlyKpiService } from "../../services/monthlyKpiService";
import { visitorAnalyticsService } from "../../services/visitorAnalyticsService";
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

/**
 * Visitor analytics: daily/monthly/yearly DISTINCT visitor counts and approximate
 * geography, for the Reports visitor trend chart. Reads only — the report() service
 * fills any missing closed-year snapshots, but never mutates daily/monthly data.
 * Raw IPs are never stored or returned; only HMAC-derived distinct counts are.
 *
 * `from`/`to` are optional Lagos calendar dates (YYYY-MM-DD) that bound the DAILY
 * series — this is what drives pagination (default: last 10 days) and a date
 * filter. The span is capped so a single request can never scan the whole table.
 */
const LAGOS_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_DAILY_SPAN_DAYS = 93;

reportRoutes.get("/visitors", async (c) => {
  requirePermissionOf(c, PERMISSIONS.ordersRead);

  const from = c.req.query("from");
  const to = c.req.query("to");
  let range: { from: string; to: string } | null = null;
  if (from !== undefined || to !== undefined) {
    if (!from || !to || !LAGOS_DATE.test(from) || !LAGOS_DATE.test(to) || from > to) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "from and to must be Lagos dates (YYYY-MM-DD) with from on or before to" },
      }, 400);
    }
    const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    if (spanDays > MAX_DAILY_SPAN_DAYS) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: `date range must span at most ${MAX_DAILY_SPAN_DAYS} days` },
      }, 400);
    }
    range = { from, to };
  }

  const report = await visitorAnalyticsService.report(createDb(c.env.DATABASE_URL), new Date(), range);
  return c.json({
    ...report,
    notice:
      "Distinct visitor counts are not additive across days, months or years. Geography is approximate, derived from request metadata, and never exposes raw IP addresses.",
  });
});
