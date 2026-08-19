-- #254 (KAX-ADR-0002): the printability engine's input, as a SIDE TABLE.
--
-- Deliberately NOT columns on artifacts: formatArtifact() spreads the whole
-- row (...a) and is the shared formatter for every public surface, so any
-- column added to artifacts is published the same day. A side table keeps
-- measurement private until a route chooses to expose it.
--
-- Measured lazily on demand only — no backfill, no scheduler: the upstream
-- host aggressively 429s, most of the corpus is not commercially eligible,
-- and a backfilled measurement goes stale against a URL KAX does not control.
CREATE TABLE IF NOT EXISTS artifact_print_assets (
  artifact_id         integer PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  width_px            integer,
  height_px           integer,
  format              varchar(16),
  has_alpha           boolean,
  color_space         varchar(16),          -- NULL means unknown; see assumed_srgb
  assumed_srgb        boolean NOT NULL DEFAULT false,
  byte_size           bigint,
  sha256              text,
  source_url_at_fetch text,
  fetched_at          timestamp,
  failure_reason      varchar(48),          -- not_a_url | sentinel | fetch_failed | too_large | decode_failed
  created_at          timestamp NOT NULL DEFAULT now()
);
