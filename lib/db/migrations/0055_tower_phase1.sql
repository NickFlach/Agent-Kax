-- KAX-ADR-0005 Phase 1: tenant-scoped credentials, the signed webhook feed's
-- durable outbox, and the webhook registration columns. A credential is
-- floor-pinned and stored HASHED (the token is shown once at mint, like the
-- webhook secret); an event row is the outbox discipline the settlement path
-- already uses — delivery is retried, never fire-and-forget.

CREATE TABLE IF NOT EXISTS tower_credentials (
  id bigserial PRIMARY KEY,
  floor_no integer NOT NULL,
  token_hash text NOT NULL,
  label text,
  created_at timestamp NOT NULL DEFAULT now(),
  revoked_at timestamp,
  CONSTRAINT tower_credentials_floor_range CHECK (floor_no BETWEEN 2 AND 11)
);
CREATE UNIQUE INDEX IF NOT EXISTS tower_credentials_hash_unique ON tower_credentials (token_hash);
CREATE INDEX IF NOT EXISTS tower_credentials_floor_idx ON tower_credentials (floor_no);

ALTER TABLE tower_floors ADD COLUMN IF NOT EXISTS webhook_url text;
ALTER TABLE tower_floors ADD COLUMN IF NOT EXISTS webhook_secret text;

CREATE TABLE IF NOT EXISTS tower_floor_events (
  id bigserial PRIMARY KEY,
  floor_no integer NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  delivered_at timestamp,
  CONSTRAINT tower_floor_events_state_known CHECK (state IN ('pending', 'delivered', 'failed'))
);
CREATE INDEX IF NOT EXISTS tower_floor_events_due_idx ON tower_floor_events (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS tower_floor_events_floor_idx ON tower_floor_events (floor_no);
