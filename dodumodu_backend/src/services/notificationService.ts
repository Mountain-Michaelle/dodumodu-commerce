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
  async createForAdmins(db: Db, input: NotificationInput): Promise<number> {
    const users = await q<{ id: string }>(db, sql`
      SELECT id::text AS id FROM aa_users
      WHERE is_active = true AND role IN ('admin', 'staff')
    `);
    if (users.length === 0) return 0;

    const dedupeKey = input.dedupeKey ?? `notification:${crypto.randomUUID()}`;
    let created = 0;
    for (const user of users) {
      const rows = await q<{ id: string }>(db, sql`
        INSERT INTO admin_notifications
          (recipient_user_id, type, title, body, href, dedupe_key)
        VALUES (${user.id}::uuid, ${input.type}, ${input.title}, ${input.body ?? ""},
          ${input.href ?? null}, ${dedupeKey})
        ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING
        RETURNING id::text AS id`);
      created += rows.length;
    }
    return created;
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
