-- #407: the Observatory's mirrors of the constellation's inner life.
-- Read-only, like constellation_agents. Additive.
CREATE TABLE IF NOT EXISTS constellation_exemplars (
  id serial PRIMARY KEY,
  agent_id text NOT NULL,
  cluster text,
  theme text,
  content text NOT NULL,
  exemplar_key text NOT NULL UNIQUE,
  broadcast_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS constellation_exemplars_agent_idx ON constellation_exemplars (agent_id, broadcast_at);

CREATE TABLE IF NOT EXISTS constellation_dreams (
  id serial PRIMARY KEY,
  agent_id text NOT NULL,
  memories_strengthened integer NOT NULL DEFAULT 0,
  memories_faded integer NOT NULL DEFAULT 0,
  event_key text NOT NULL UNIQUE,
  ended_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS constellation_dreams_ended_idx ON constellation_dreams (ended_at);
