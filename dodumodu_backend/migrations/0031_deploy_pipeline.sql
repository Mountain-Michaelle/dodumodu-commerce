-- Deploy pipeline v2. Additive and re-runnable: every statement is IF NOT EXISTS / guarded.
--
-- product_publishes.publish_ref : the public, unguessable id of one publish ("pub_" + 20 hex). It is what the
--                                 storefront page carries, so LIVE means "this exact snapshot is being served".
-- product_publishes.content_hash: hash of the snapshot content; publishing identical content again reuses the row
--                                 instead of minting a new publish.
-- site_builds                   : one row per GitHub Actions run, now with live progress (current step, run link).
-- deploy_events                 : the step-by-step log the admin panel shows while a build runs.
-- (the deploy_* columns of 0030 are repeated here so a database that never saw 0030 is still correct)

ALTER TABLE product_publishes
  ADD COLUMN IF NOT EXISTS deploy_error        text,
  ADD COLUMN IF NOT EXISTS deploy_http_status  integer,
  ADD COLUMN IF NOT EXISTS deploy_attempts     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deploy_attempted_at timestamp,
  ADD COLUMN IF NOT EXISTS publish_ref         text,
  ADD COLUMN IF NOT EXISTS content_hash        text;

UPDATE product_publishes
   SET publish_ref = 'pub_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)
 WHERE publish_ref IS NULL;

ALTER TABLE product_publishes ALTER COLUMN publish_ref SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS product_publishes_publish_ref_key ON product_publishes (publish_ref);

ALTER TABLE site_builds
  ADD COLUMN IF NOT EXISTS trigger_publish_id integer,
  ADD COLUMN IF NOT EXISTS run_url            text,
  ADD COLUMN IF NOT EXISTS current_step       text,
  ADD COLUMN IF NOT EXISTS failed_step        text,
  ADD COLUMN IF NOT EXISTS last_event_at      timestamp NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS deploy_events (
  id          bigserial PRIMARY KEY,
  build_id    text      NOT NULL,
  step        text      NOT NULL,
  label       text      NOT NULL DEFAULT '',
  status      text      NOT NULL,
  message     text,
  created_at  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deploy_events_build_idx ON deploy_events (build_id, id);
