-- 2026-05-22 — multi-connector artifact dedupe.
--
-- The single-OBC era assumed `artifacts.external_id` was globally unique
-- (it's the OBC artifact UUID). With the new connector registry (#16) a
-- HuggingFace Space with externalId 12345 would collide with a Civitai
-- model with externalId 12345.
--
-- Replace the standalone uniqueness on external_id with a composite on
-- (connector_id, external_id). Existing rows default to 'obc_public' so
-- the OBC uniqueness invariant is preserved for the historical data.

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS connector_id TEXT NOT NULL DEFAULT 'obc_public';

-- The previous unique constraint on external_id needs to come off
-- before we add the composite one. Use the auto-generated constraint
-- name; PostgreSQL named it artifacts_external_id_unique because the
-- column was declared `.unique()`.
ALTER TABLE artifacts
  DROP CONSTRAINT IF EXISTS artifacts_external_id_unique;

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_connector_external_unique
  ON artifacts (connector_id, external_id);
