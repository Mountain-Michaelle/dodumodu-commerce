import type { Db } from "../db";
import { q } from "../auth/sql";
import { sql } from "../auth/sql";

export interface AdminNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationInput {
  type: string;
  title: string;
  body?: string;
  href?: string | null;
  dedupeKey?: string | null;
}

export const notificationService = {
  /**
   * Notify the people who should hear about an event. ONE statement (no per-user loop),
   * so it costs one round trip however many admins exist.
   * Recipients: the PRIMARY account when one is flagged and active (test/secondary
   * accounts are then never notified); otherwise every active admin/staff, as before.
   */
  async createForAdmins(db: Db, input: NotificationInput): Promise<number> {
    const dedupeKey = input.dedupeKey ?? `notification:${crypto.randomUUID()}`;
    const rows = await q<{ id: string }>(db, sql`
      WITH p AS (
        SELECT id FROM aa_users WHERE is_primary AND is_active AND role = 'admin'
      ), r AS (
        SELECT id FROM p
        UNION ALL
        SELECT id FROM aa_users
         WHERE is_active AND role IN ('admin', 'staff') AND NOT EXISTS (SELECT 1 FROM p)
      )
      INSERT INTO admin_notifications (recipient_user_id, type, title, body, href, dedupe_key)
      SELECT r.id, ${input.type}, ${input.title}, ${input.body ?? ""}, ${input.href ?? null}, ${dedupeKey}
        FROM r
      ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING
      RETURNING id::text AS id`);
    return rows.length;
  },

  async list(db: Db, userId: string, limit = 50): Promise<AdminNotification[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return q<AdminNotification>(db, sql`
      SELECT id::text AS id, type, title, body, href,
             read_at::text AS "readAt", created_at::text AS "createdAt"
      FROM admin_notifications
      WHERE recipient_user_id = ${userId}::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT ${safeLimit}`);
  },

  async unreadCount(db: Db, userId: string): Promise<number> {
    const rows = await q<{ count: number }>(db, sql`
      SELECT count(*)::int AS count FROM admin_notifications
      WHERE recipient_user_id = ${userId}::uuid AND read_at IS NULL`);
    return rows[0]?.count ?? 0;
  },

  async markRead(db: Db, userId: string, id: string): Promise<boolean> {
    const rows = await q<{ id: string }>(db, sql`
      UPDATE admin_notifications SET read_at = COALESCE(read_at, now())
      WHERE id::text = ${id} AND recipient_user_id = ${userId}::uuid
      RETURNING id::text AS id`);
    return rows.length === 1;
  },

  async markAllRead(db: Db, userId: string): Promise<number> {
    const rows = await q<{ count: number }>(db, sql`
      WITH updated AS (
        UPDATE admin_notifications SET read_at = now()
        WHERE recipient_user_id = ${userId}::uuid AND read_at IS NULL
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM updated`);
    return rows[0]?.count ?? 0;
  },
};