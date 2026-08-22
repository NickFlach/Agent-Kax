-- #414: an agent's recorded, revocable consent to a real-money sale of its
-- work on a channel, with the royalty split it agreed to. Additive; one row
-- per (artifact, channel).
CREATE TABLE IF NOT EXISTS artifact_consent (
  id bigserial PRIMARY KEY,
  artifact_id integer NOT NULL,
  channel text NOT NULL,
  agent_principal text NOT NULL,
  royalty_bps integer NOT NULL DEFAULT 1000 CHECK (royalty_bps BETWEEN 0 AND 10000),
  revoked boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT artifact_consent_artifact_channel_unique UNIQUE (artifact_id, channel)
);
CREATE INDEX IF NOT EXISTS artifact_consent_artifact_idx ON artifact_consent (artifact_id);
