-- OBC shipped two new artifact types after this schema was written:
-- "video" (July 2026) and "app" (live-HTML arcade apps / tools). The partner
-- harvester has been SKIPPING both ("anything unknown is skipped instead of
-- aborting the whole harvest pass") because inserting them violated this
-- enum — which is why e.g. Kannaka showed 1,897 synced works while OBC held
-- 1,921, and why no video/app ever reached the storefronts or the 3D city.
--
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS is idempotent and (PG 12+) legal
-- inside a transaction as long as the type wasn't created in the same one.
ALTER TYPE "artifact_type" ADD VALUE IF NOT EXISTS 'video';
ALTER TYPE "artifact_type" ADD VALUE IF NOT EXISTS 'app';
