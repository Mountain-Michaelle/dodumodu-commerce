-- Additive: remembers what the last deploy attempt for a publish actually did, so the admin can show the exact error.
ALTER TABLE product_publishes
  ADD COLUMN IF NOT EXISTS deploy_error          text,
  ADD COLUMN IF NOT EXISTS deploy_http_status    integer,
  ADD COLUMN IF NOT EXISTS deploy_attempts       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deploy_attempted_at   timestamp;
