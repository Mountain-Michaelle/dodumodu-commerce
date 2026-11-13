// SQL for the spam-hold and rotating-phone-flood rules. Kept apart from the rules (spamDetect.ts) so the rules stay
// pure, and apart from the HTTP layer so the same queries serve the order route and the admin screens.
import type { Db } from "../db";
import { q, q1, sql } from "../auth/sql";
import type { PhoneFacts, SubjectFacts } from "./spamDetect";
import type { SpamConfig } from "./spamConfig";

const normText = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Everything the spam rule needs about one phone, in ONE round trip. Held orders count towards the window. */
export async function phoneFacts(
  db: Db, cfg: SpamConfig, input: { phoneNorm: string; customerName: string; address: string },
): Promise<PhoneFacts> {
  const name = normText(input.customerName);
  const addr = normText(input.address);
  const row = await q1<{ prior: number; similar: number; burst: number; trusted: boolean }>(db, sql`
    WITH recent AS (
      SELECT lower(btrim(customer_name)) AS n, lower(regexp_replace(btrim(address), '\s+', ' ', 'g')) AS a, created_at
        FROM orders
       WHERE phone_norm = ${input.phoneNorm} AND created_at > now() - make_interval(hours => ${cfg.windowHours})
      UNION ALL
      SELECT lower(btrim(customer_name)), lower(regexp_replace(btrim(address), '\s+', ' ', 'g')), created_at
        FROM held_orders
       WHERE phone_norm = ${input.phoneNorm} AND status <> 'released'
         AND created_at > now() - make_interval(hours => ${cfg.windowHours})
    )
    SELECT count(*)::int AS prior,
           (count(*) FILTER (WHERE n = ${name} OR a = ${addr}))::int AS similar,
           (count(*) FILTER (WHERE created_at > now() - make_interval(mins => ${cfg.burstMinutes})))::int AS burst,
           EXISTS (SELECT 1 FROM orders WHERE phone_norm = ${input.phoneNorm} AND status IN ('paid', 'delivered')) AS trusted
      FROM recent`);
  return { prior: row?.prior ?? 0, similar: row?.similar ?? 0, burst: row?.burst ?? 0, trusted: row?.trusted ?? false };
}

// ---------------------------------------------------------------- held orders

export interface HeldRow {
  id: number; idempotency_key: string; reference: string; phone_norm: string | null; phone: string; customer_name: string;
  address: string; ip: string | null; device_id: string | null; client_kind: string | null; browser: string | null;
  reason: string; payload: Record<string, unknown>; emailed: boolean; status: "held" | "released" | "dismissed";
  released_order_id: number | null; resolved_by: string | null; resolved_at: string | null; created_at: string;
}

export interface NewHeld {
  idempotencyKey: string; reference: string; phoneNorm: string | null; phone: string; customerName: string; address: string;
  ip: string | null; deviceId: string | null; clientKind: string | null; browser: string | null; reason: string;
  payload: Record<string, unknown>;
}

const HELD_COLS = sql`id, idempotency_key, reference, phone_norm, phone, customer_name, address, ip, device_id, client_kind,
  browser, reason, payload, emailed, status, released_order_id, resolved_by, resolved_at::text AS resolved_at, created_at::text AS created_at`;

export async function findHeldByKey(db: Db, key: string): Promise<HeldRow | null> {
  return q1<HeldRow>(db, sql`SELECT ${HELD_COLS} FROM held_orders WHERE idempotency_key = ${key}`);
}
export async function getHeld(db: Db, id: number): Promise<HeldRow | null> {
  return q1<HeldRow>(db, sql`SELECT ${HELD_COLS} FROM held_orders WHERE id = ${id}`);
}

/** Inserts the held order. Returns null when the same idempotency key is already held (a retry). */
export async function insertHeld(db: Db, h: NewHeld): Promise<HeldRow | null> {
  return q1<HeldRow>(db, sql`
    INSERT INTO held_orders (idempotency_key, reference, phone_norm, phone, customer_name, address, ip, device_id,
                             client_kind, browser, reason, payload)
    VALUES (${h.idempotencyKey}, ${h.reference}, ${h.phoneNorm}, ${h.phone}, ${h.customerName}, ${h.address}, ${h.ip},
            ${h.deviceId}, ${h.clientKind}, ${h.browser}, ${h.reason}, ${JSON.stringify(h.payload)}::jsonb)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING ${HELD_COLS}`);
}

export async function markHeldEmailed(db: Db, id: number): Promise<void> {
  await q(db, sql`UPDATE held_orders SET emailed = true WHERE id = ${id}`);
}

export interface HeldFilter { status?: "held" | "released" | "dismissed" | "all"; q?: string; from?: string; to?: string; limit?: number; offset?: number }

function heldWhere(f: HeldFilter) {
  const status = f.status && f.status !== "all" ? f.status : null;
  const like = f.q && f.q.trim() ? `%${f.q.trim().replace(/[%_\\]/g, (m) => "\\" + m)}%` : null;
  return sql`(${status}::text IS NULL OR status = ${status})
    AND (${like}::text IS NULL OR phone ILIKE ${like} OR phone_norm ILIKE ${like} OR customer_name ILIKE ${like}
         OR ip ILIKE ${like} OR reference ILIKE ${like})
    AND (${f.from ?? null}::timestamptz IS NULL OR created_at >= ${f.from ?? null}::timestamptz)
    AND (${f.to ?? null}::timestamptz IS NULL OR created_at <= ${f.to ?? null}::timestamptz)`;
}

export async function listHeld(db: Db, f: HeldFilter): Promise<{ rows: HeldRow[]; total: number }> {
  const limit = Math.max(1, Math.min(200, f.limit ?? 50));
  const offset = Math.max(0, f.offset ?? 0);
  const [rows, count] = await Promise.all([
    q<HeldRow>(db, sql`SELECT ${HELD_COLS} FROM held_orders WHERE ${heldWhere(f)} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`),
    q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM held_orders WHERE ${heldWhere(f)}`),
  ]);
  return { rows, total: count?.n ?? 0 };
}

export async function countHeldOpen(db: Db): Promise<number> {
  return (await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM held_orders WHERE status = 'held'`))?.n ?? 0;
}

/** Atomically takes a held order out of 'held'. Null when it was already resolved (so a double click acts once). */
export async function resolveHeld(
  db: Db, id: number, status: "released" | "dismissed", by: string, orderId: number | null,
): Promise<HeldRow | null> {
  return q1<HeldRow>(db, sql`
    UPDATE held_orders SET status = ${status}, resolved_by = ${by}, resolved_at = now(), released_order_id = ${orderId}
     WHERE id = ${id} AND status = 'held'
    RETURNING ${HELD_COLS}`);
}

/** Removes a held row outright (only for one that could not be announced, so a retry starts clean). */
export async function deleteHeld(db: Db, id: number): Promise<void> {
  await q(db, sql`DELETE FROM held_orders WHERE id = ${id} AND status = 'held'`);
}

/** Puts a held order back (used only when releasing failed after it was claimed). */
export async function unresolveHeld(db: Db, id: number): Promise<void> {
  await q(db, sql`UPDATE held_orders SET status = 'held', resolved_by = NULL, resolved_at = NULL, released_order_id = NULL WHERE id = ${id}`);
}

// ---------------------------------------------------------------- RPF alerts

/** Distinct untrusted phones placing orders from one device / one address inside the RPF window. */
export async function subjectFacts(
  db: Db, cfg: SpamConfig, scope: "ip" | "device", value: string,
): Promise<SubjectFacts & { orderIds: number[] }> {
  const rows = scope === "ip"
    ? await q<{ id: number; phone_norm: string }>(db, sql`
        SELECT o.id, o.phone_norm FROM orders o
         WHERE o.created_from_ip = ${value} AND o.phone_norm IS NOT NULL AND o.deleted_at IS NULL
           AND o.created_at > now() - make_interval(mins => ${cfg.rpfWindowMinutes})
           AND NOT EXISTS (SELECT 1 FROM orders t WHERE t.phone_norm = o.phone_norm AND t.status IN ('paid', 'delivered'))
         ORDER BY o.id`)
    : await q<{ id: number; phone_norm: string }>(db, sql`
        SELECT o.id, o.phone_norm FROM orders o
         WHERE o.device_id = ${value} AND o.phone_norm IS NOT NULL AND o.deleted_at IS NULL
           AND o.created_at > now() - make_interval(mins => ${cfg.rpfWindowMinutes})
           AND NOT EXISTS (SELECT 1 FROM orders t WHERE t.phone_norm = o.phone_norm AND t.status IN ('paid', 'delivered'))
         ORDER BY o.id`);
  return { untrustedPhones: new Set(rows.map((r) => r.phone_norm)).size, orders: rows.length, orderIds: rows.map((r) => r.id) };
}

export interface AlertRow {
  id: number; kind: string; subject_scope: "ip" | "device"; subject_value: string; ip: string | null; device_id: string | null;
  client_kind: string | null; browser: string | null; distinct_phones: number; order_count: number; order_ids: number[];
  window_minutes: number; status: "open" | "blocked" | "dismissed"; emailed: boolean; resolved_by: string | null;
  resolved_at: string | null; resolution_note: string | null; created_at: string; updated_at: string;
}
const ALERT_COLS = sql`id, kind, subject_scope, subject_value, ip, device_id, client_kind, browser, distinct_phones, order_count,
  order_ids, window_minutes, status, emailed, resolved_by, resolved_at::text AS resolved_at, resolution_note,
  created_at::text AS created_at, updated_at::text AS updated_at`;

export interface AlertInput {
  scope: "ip" | "device"; value: string; ip: string | null; deviceId: string | null; clientKind: string | null;
  browser: string | null; phones: number; orders: number; orderIds: number[]; windowMinutes: number;
}

const intArray = (ids: number[]) => ids.length === 0 ? sql`ARRAY[]::int[]` : sql`ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::int[]`;

/** Creates the open alert for a subject, or refreshes its numbers. `created` is true only the first time. */
export async function upsertOpenAlert(db: Db, a: AlertInput): Promise<{ row: AlertRow; created: boolean }> {
  const row = await q1<AlertRow & { inserted: boolean }>(db, sql`
    INSERT INTO abuse_alerts (subject_scope, subject_value, ip, device_id, client_kind, browser, distinct_phones, order_count,
                              order_ids, window_minutes)
    VALUES (${a.scope}, ${a.value}, ${a.ip}, ${a.deviceId}, ${a.clientKind}, ${a.browser}, ${a.phones}, ${a.orders},
            ${intArray(a.orderIds)}, ${a.windowMinutes})
    ON CONFLICT (subject_scope, subject_value) WHERE status = 'open'
    DO UPDATE SET distinct_phones = EXCLUDED.distinct_phones, order_count = EXCLUDED.order_count,
                  order_ids = EXCLUDED.order_ids, updated_at = now(),
                  ip = COALESCE(EXCLUDED.ip, abuse_alerts.ip), device_id = COALESCE(EXCLUDED.device_id, abuse_alerts.device_id),
                  browser = COALESCE(EXCLUDED.browser, abuse_alerts.browser)
    RETURNING ${ALERT_COLS}, (xmax = 0) AS inserted`);
  if (!row) throw new Error("alert upsert returned no row");
  const { inserted, ...rest } = row;
  return { row: rest as AlertRow, created: inserted };
}

export async function markAlertEmailed(db: Db, id: number): Promise<void> {
  await q(db, sql`UPDATE abuse_alerts SET emailed = true WHERE id = ${id}`);
}
export async function getAlert(db: Db, id: number): Promise<AlertRow | null> {
  return q1<AlertRow>(db, sql`SELECT ${ALERT_COLS} FROM abuse_alerts WHERE id = ${id}`);
}

export interface AlertFilter { status?: "open" | "blocked" | "dismissed" | "all"; scope?: "ip" | "device"; q?: string; limit?: number; offset?: number }

function alertWhere(f: AlertFilter) {
  const status = f.status && f.status !== "all" ? f.status : null;
  const like = f.q && f.q.trim() ? `%${f.q.trim().replace(/[%_\\]/g, (m) => "\\" + m)}%` : null;
  return sql`(${status}::text IS NULL OR status = ${status}) AND (${f.scope ?? null}::text IS NULL OR subject_scope = ${f.scope ?? null})
    AND (${like}::text IS NULL OR subject_value ILIKE ${like} OR ip ILIKE ${like} OR device_id ILIKE ${like} OR browser ILIKE ${like})`;
}

export async function listAlerts(db: Db, f: AlertFilter): Promise<{ rows: AlertRow[]; total: number }> {
  const limit = Math.max(1, Math.min(200, f.limit ?? 50));
  const offset = Math.max(0, f.offset ?? 0);
  const [rows, count] = await Promise.all([
    q<AlertRow>(db, sql`SELECT ${ALERT_COLS} FROM abuse_alerts WHERE ${alertWhere(f)} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`),
    q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM abuse_alerts WHERE ${alertWhere(f)}`),
  ]);
  return { rows, total: count?.n ?? 0 };
}

export async function countOpenAlerts(db: Db): Promise<number> {
  return (await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM abuse_alerts WHERE status = 'open'`))?.n ?? 0;
}

/** Closes an open alert. Null when it was already closed, so a double click acts once. */
export async function resolveAlert(db: Db, id: number, status: "blocked" | "dismissed", by: string, note: string | null): Promise<AlertRow | null> {
  return q1<AlertRow>(db, sql`
    UPDATE abuse_alerts SET status = ${status}, resolved_by = ${by}, resolved_at = now(), resolution_note = ${note}, updated_at = now()
     WHERE id = ${id} AND status = 'open'
    RETURNING ${ALERT_COLS}`);
}

/** Marks the orders of an alert so the orders list can be filtered by them. Never changes anything else on the order. */
export async function tagOrders(db: Db, ids: number[], tag: string | null): Promise<void> {
  if (ids.length === 0) return;
  await q(db, sql`UPDATE orders SET abuse_tag = ${tag} WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
}
