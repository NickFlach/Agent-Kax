-- #403 (KAX-ADR-0003 v0.2, D4/D5): the tier-promotion enforcement wrapper.
--
-- capability_merge_receipts: the evidence the tier evaluators judge, one row
-- per merged PR the fleet learns about (by_kind derived server-side).
-- signed_action_records: the server-side signed action chain a tier change is
-- written into. Additive.
CREATE TABLE IF NOT EXISTS capability_merge_receipts (
  id bigserial PRIMARY KEY,
  subject text NOT NULL,
  pr_number integer NOT NULL,
  repo text NOT NULL,
  merged_by text NOT NULL,
  reviewed_by text,
  ci_green boolean NOT NULL,
  ci_covered_changed_paths boolean NOT NULL,
  within_scope boolean NOT NULL,
  reverted_by text,
  reverted_by_kind text,
  reverted_by_overlaps boolean,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT capability_merge_receipts_subject_pr_unique UNIQUE (subject, pr_number, repo)
);
CREATE INDEX IF NOT EXISTS capability_merge_receipts_subject_idx ON capability_merge_receipts (subject, id);

CREATE TABLE IF NOT EXISTS signed_action_records (
  seq integer PRIMARY KEY,
  prev_hash text NOT NULL,
  entry_hash text NOT NULL,
  commitment_id text NOT NULL,
  principal text NOT NULL,
  kind text NOT NULL,
  commit_sha text,
  ref text,
  signature text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
