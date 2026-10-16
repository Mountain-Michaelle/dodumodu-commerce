// Admin ATTENTION email outbox (spec §4.8). Enqueued in the SAME transaction as
// the mutation + its audit row; sent after commit and retried by the janitor.
//
// dedupe_key UNIQUE makes enqueue idempotent: a retry or a repeated request
// never creates a second email. The drain claims a batch with a single guarded
// UPDATE ... FOR UPDATE SKIP LOCKED (no interactive transaction — the Neon HTTP
// driver has none, per the 0017 note), sends outside any transaction, then marks
// each row sent / retry / dead. Provider failure never changes the committed
// operation.
import { q, q1, sql } from "./sql";
import type { Db } from "../db";

export interface OutboxRow {
  id: number;
  kind: string;
  eventRef: number | null;
  attempts: number;
}

/** Idempotent enqueue. Returns the new id, or null when dedupe_key already exists. */
export async function enqueue(
  db: Db, kind: string, dedupeKey: string, eventRef: number | null = null,
): Promise<number | null> {
  const row = await q1<{ id: number }>(db,
    sql`INSERT INTO aa_alert_outbox (kind, dedupe_key, event_ref)
         VALUES (${kind}, ${dedupeKey}, ${eventRef})
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`);
  return row ? row.id : null;
}

const LEASE_SECS = 120;

/**
 * Claim up to `limit` sendable rows atomically (pending, or a sending row whose
 * lease expired) and return them. One statement; SKIP LOCKED lets parallel
 * janitors never claim the same row.
 */
export async function claimOutbox(db: Db, limit: number): Promise<OutboxRow[]> {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  return q<OutboxRow>(db,
    sql`UPDATE aa_alert_outbox o
           SET status = 'sending', locked_until = now() + (${LEASE_SECS}::int * interval '1 second'),
               attempts = attempts + 1
         WHERE o.id IN (
           SELECT id FROM aa_alert_outbox
            WHERE (status = 'pending')
               OR (status = 'sending' AND (locked_until IS NULL OR locked_until < now()))
            ORDER BY next_try_at
            FOR UPDATE SKIP LOCKED
            LIMIT ${n})
         RETURNING o.id, o.kind, o.event_ref AS "eventRef", o.attempts`);
}

export async function markSent(db: Db, id: number): Promise<void> {
  await q(db, sql`UPDATE aa_alert_outbox SET status='sent', locked_until=NULL, last_error=NULL WHERE id=${id}`);
}

/** Retry with bounded exponential backoff; past max_attempts -> dead. */
export async function markRetry(db: Db, id: number, error: string): Promise<void> {
  await q(db,
    sql`UPDATE aa_alert_outbox
           SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
               locked_until = NULL,
               next_try_at = now() + (least(attempts, 8) * 60 * interval '1 second'),
               last_error = left(${error}, 500)
         WHERE id = ${id}`);
}
