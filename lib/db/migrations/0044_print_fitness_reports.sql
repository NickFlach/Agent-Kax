-- #296: the print-fitness candidacy gate's REPORT rows. Report-only is the
-- whole point of this phase: every published artifact gets its four metric
-- families and a verdict written down, and NOTHING reads the verdict to
-- gate anything — the thresholds are uncalibrated guesses until the
-- calibration run (#297) makes them real, and a gate enforcing guesses
-- would be confidently wrong at scale.
--
-- verdict is varchar, never pgEnum: pass | needs_review | fail.
-- reason is machine-readable and stable (source_below_floor,
-- vectorizer_unavailable, between_thresholds, ssim_below_floor,
-- delta_e_above_ceiling).
CREATE TABLE IF NOT EXISTS print_fitness_reports (
  id               bigserial PRIMARY KEY,
  artifact_id      integer NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  preset           varchar(24),          -- vtracer preset, NULL when the tool did not run
  ssim             real,
  mean_delta_e2000 real,
  path_count       integer,
  node_count       integer,
  svg_bytes        integer,
  color_band_count integer NOT NULL,
  verdict          varchar(16) NOT NULL,
  reason           varchar(64),
  pipeline_version varchar(24) NOT NULL,
  created_at       timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS print_fitness_reports_artifact_idx
  ON print_fitness_reports (artifact_id, created_at DESC);
