-- #264 (ADR-0002 v0.2): object storage custody and derived print masters.
--
-- The moment a DERIVED print master exists, "the print file lives durably at
-- Printify" stops being a sufficient custody story: a derived asset cannot be
-- regenerated from a URL that has rotated, and the only bucket the source
-- lives in is OBC's. So KAX takes custody of source bytes BEFORE any derived
-- asset is created, and the masters live in KAX-controlled storage — never in
-- Postgres, never as a re-fetch of the OBC URL.

-- Where the custody copy of the SOURCE bytes lives (content-addressed key in
-- the KAX bucket). NULL = custody not yet taken; the guard in
-- storage/custody.ts refuses to create derived assets while it is.
ALTER TABLE artifact_print_assets ADD COLUMN IF NOT EXISTS storage_key text;

-- An upscaled master is a NEW asset with its own provenance: its own row, its
-- own sha256, its own source_artifact_id edge. quality_status is varchar,
-- never pgEnum: pending | passed | failed | human_review.
CREATE TABLE IF NOT EXISTS derived_assets (
  id                 serial PRIMARY KEY,
  source_artifact_id integer NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  transform_type     varchar(32) NOT NULL,     -- e.g. 'upscale'
  transform_factor   real NOT NULL,
  quality_status     varchar(24) NOT NULL DEFAULT 'pending',
  storage_key        text NOT NULL,
  sha256             text NOT NULL,
  byte_size          bigint,
  width_px           integer,
  height_px          integer,
  reviewed_by        text,
  reviewed_at        timestamp,
  created_at         timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS derived_assets_source_idx
  ON derived_assets (source_artifact_id, created_at DESC);
