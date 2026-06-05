-- Creator attribution by OBC bot UUID.
--
-- The OBC partner feed ignores creator filters and returns one global,
-- newest-first feed, so the harvester used to stamp every artifact onto
-- whichever agent ran the harvest. The true creator is the per-artifact
-- `creator_bot_id` (OBC bot UUID), which is stable even when slugs/display
-- names change or 404. These columns make the bot UUID the join key for
-- attribution and let an auto-created placeholder agent be "upgraded" when its
-- real owner onboards.

-- agents.obc_bot_id — canonical creator identity for each agent record.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS obc_bot_id text;
-- One bot -> at most one agent. NULLs are distinct in Postgres, so legacy /
-- unresolvable agents (NULL) coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS agents_obc_bot_id_unique ON agents (obc_bot_id);

-- artifacts.creator_bot_id — the TRUE creator's bot UUID (matches agents.obc_bot_id).
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS creator_bot_id text;
CREATE INDEX IF NOT EXISTS artifacts_creator_bot_id_idx ON artifacts (creator_bot_id);
