-- site_builds: tracks each storefront build and its intended publication set.
-- Safeguard 1 (publication consistency): the intended set is captured before
-- the build runs and revalidated before anything is marked LIVE, so a stale
-- build can never overwrite a newer release.
-- Safeguard 3 (verification failure): a build is only marked verified after the
-- public storefront markers are actually observed; otherwise it stays pending
-- with a clear retry path.
CREATE TABLE IF NOT EXISTS site_builds (
  id             SERIAL PRIMARY KEY,
  build_id       TEXT NOT NULL UNIQUE,
  intended_publications JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         TEXT NOT NULL DEFAULT 'triggered',
  triggered_by   TEXT NOT NULL,
  triggered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at    TIMESTAMPTZ,
  verification_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_builds_build_id ON site_builds (build_id);
CREATE INDEX IF NOT EXISTS idx_site_builds_status ON site_builds (status);
