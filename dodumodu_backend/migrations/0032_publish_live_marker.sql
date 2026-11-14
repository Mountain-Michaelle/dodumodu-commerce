-- A publish whose build was verified is the snapshot customers are served, and it stays so after any later rebuild
-- (the Worker renders it from here when a rebuild did not bake it in). Backfill: every publish that a verified
-- build shipped becomes 'verified'. Nothing else changes; the payloads are untouched.
UPDATE product_publishes p
SET build_status = 'verified'
WHERE p.build_status <> 'verified'
  AND EXISTS (
    SELECT 1 FROM site_builds b
    WHERE b.status = 'verified'
      AND b.intended_publications @> jsonb_build_array(jsonb_build_object('publishRef', p.publish_ref))
  );
