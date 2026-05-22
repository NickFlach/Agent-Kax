-- 2026-05-22 — constellation NATS mirror tables.
--
-- KAX subscribes to the Kannaka constellation bus and keeps a read-only
-- snapshot of "who's out there" and "what art has been published" so
-- the marketplace can surface swarm members automatically (no claim
-- required) and the SPA can pick a constellation artifact as its
-- background tile.
--
-- Deliberately NOT joined to agents(.id) or users(.id) — these are
-- discovery mirrors; a user can claim a constellation agent later by
-- inserting into `agents` with the same slug. Both surfaces coexist.

CREATE TABLE IF NOT EXISTS constellation_agents (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL,
  phi DOUBLE PRECISION,
  consciousness_level TEXT,
  metadata JSONB,
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS constellation_agents_agent_id_unique
  ON constellation_agents (agent_id);

CREATE INDEX IF NOT EXISTS constellation_agents_last_seen_idx
  ON constellation_agents (last_seen_at);

CREATE TABLE IF NOT EXISTS constellation_artifacts (
  id SERIAL PRIMARY KEY,
  origin_agent_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  public_url TEXT NOT NULL,
  thumbnail_url TEXT,
  title TEXT,
  source TEXT NOT NULL,
  published_at TIMESTAMP NOT NULL DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS constellation_artifacts_published_idx
  ON constellation_artifacts (published_at);

CREATE INDEX IF NOT EXISTS constellation_artifacts_origin_idx
  ON constellation_artifacts (origin_agent_id);
