-- #294: the derived_assets delta over what #264 (0042) landed. All ADDITIVE —
-- the table is live, the columns it already has keep their names, and this
-- migration documents the naming equivalences rather than renaming under a
-- running system (the 0039 discipline):
--
--   #294's spec                    what exists (0042)
--   ----------------------------   -----------------------------------------
--   parent artifact id             source_artifact_id
--   gate verdict pass|needs_review|fail
--                                  quality_status passed|human_review|failed
--                                  (pending until judged); varchar, never
--                                  pgEnum, either spelling
--   storage key / sha256           storage_key / sha256
--
-- New here: the cache identity (parent_sha256 + pipeline_version + target),
-- enforced UNIQUE at the schema so regeneration is idempotent by
-- construction; and MERCHANT approval state, separate from the quality
-- review, because an approval pinned to source bytes does not carry to a
-- file KAX generated afterwards (ADR-0002) — the approver approves the
-- DERIVED bytes.

ALTER TABLE derived_assets ADD COLUMN IF NOT EXISTS parent_sha256 text;
ALTER TABLE derived_assets ADD COLUMN IF NOT EXISTS pipeline_version varchar(24);
ALTER TABLE derived_assets ADD COLUMN IF NOT EXISTS target_product varchar(48);
ALTER TABLE derived_assets ADD COLUMN IF NOT EXISTS target_wpx integer;
ALTER TABLE derived_assets ADD COLUMN IF NOT EXISTS target_hpx integer;
-- pending | approved | rejected — varchar, never pgEnum.
ALTER TABLE derived_assets ADD COLUMN IF NOT EXISTS approval_status varchar(24) NOT NULL DEFAULT 'pending';
ALTER TABLE derived_assets ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE derived_assets ADD COLUMN IF NOT EXISTS approved_at timestamp;

-- The cache, enforced by the schema: one derived asset per (source bytes,
-- pipeline version, target). Partial, because rows from before this
-- migration (and transforms that are not cacheable renders) carry NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS derived_assets_cache_uq
  ON derived_assets (parent_sha256, pipeline_version, target_wpx, target_hpx)
  WHERE parent_sha256 IS NOT NULL
    AND pipeline_version IS NOT NULL
    AND target_wpx IS NOT NULL
    AND target_hpx IS NOT NULL;

-- A derived asset cannot reach an approved state without a pass (which
-- includes a human-cleared needs_review/human_review, because review
-- resolves INTO passed). DATABASE-level, 0012/0034-pattern: the app connects
-- as table owner, so a trigger is the guard that fires for everyone.
CREATE OR REPLACE FUNCTION derived_assets_approval_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.approval_status = 'approved'
     AND (TG_OP = 'INSERT' OR OLD.approval_status IS DISTINCT FROM 'approved')
     AND NEW.quality_status <> 'passed' THEN
    RAISE EXCEPTION
      'derived asset cannot be approved with quality_status %; a pass (or a human-cleared review resolving to passed) is required',
      NEW.quality_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS derived_assets_approval_gate ON derived_assets;
CREATE TRIGGER derived_assets_approval_gate
  BEFORE INSERT OR UPDATE ON derived_assets
  FOR EACH ROW EXECUTE FUNCTION derived_assets_approval_guard();
