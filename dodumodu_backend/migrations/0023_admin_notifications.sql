CREATE TABLE IF NOT EXISTS admin_notifications (
  id              BIGSERIAL PRIMARY KEY,
  recipient_user_id UUID NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  href            TEXT,
  dedupe_key      TEXT NOT NULL DEFAULT '',
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recipient_user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_admin_notifications_recipient_unread
  ON admin_notifications (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_admin_notifications_recipient_created
  ON admin_notifications (recipient_user_id, created_at DESC);
