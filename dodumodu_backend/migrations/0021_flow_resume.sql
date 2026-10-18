-- Flow resume: 5-minute step window for refresh-resume.
-- last_step_at is touched on every successful step transition; GET /auth/status
-- treats a flow as resumable only when last_step_at > now() - 5 minutes.
ALTER TABLE aa_auth_flows ADD COLUMN IF NOT EXISTS last_step_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_aa_auth_flows_last_step ON aa_auth_flows (last_step_at);
