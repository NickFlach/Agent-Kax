-- Repair/ensure the residences floor plan (#191).
--
-- `GET /residences/units` began returning 500 in production after a deploy,
-- while every other endpoint stayed healthy and the same query kept passing in
-- CI. That shape — one table's query failing, everything else fine — means the
-- table or its columns went missing in prod, not that the code broke.
--
-- Migration 0018 is recorded as applied and will never run again, so it cannot
-- put back whatever was lost. This one is deliberately idempotent and additive:
-- it re-creates the table if absent, re-adds any individual column that has
-- gone missing, restores the two indexes, and re-seeds the 80 units only if
-- they are not already there. Running it against a healthy database is a no-op.
--
-- Deliberately NOT destructive: nothing is dropped, so a resident who has
-- already claimed a home keeps it.

CREATE TABLE IF NOT EXISTS residence_units (
  id          serial PRIMARY KEY,
  floor       integer NOT NULL,
  letter      text    NOT NULL,
  tier        integer NOT NULL,
  agent_id    integer REFERENCES agents(id) ON DELETE SET NULL,
  claimed_at  timestamp,
  created_at  timestamp NOT NULL DEFAULT now()
);

-- Columns, individually, in case the table survived but a column did not.
ALTER TABLE residence_units ADD COLUMN IF NOT EXISTS floor      integer;
ALTER TABLE residence_units ADD COLUMN IF NOT EXISTS letter     text;
ALTER TABLE residence_units ADD COLUMN IF NOT EXISTS tier       integer;
ALTER TABLE residence_units ADD COLUMN IF NOT EXISTS agent_id   integer;
ALTER TABLE residence_units ADD COLUMN IF NOT EXISTS claimed_at timestamp;
ALTER TABLE residence_units ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS residence_units_floor_letter_unique
  ON residence_units (floor, letter);

CREATE UNIQUE INDEX IF NOT EXISTS residence_units_agent_unique
  ON residence_units (agent_id);

-- Re-seed floors 2–11 x A–H. ON CONFLICT keeps existing rows, so occupied
-- units are untouched and only genuinely missing ones are restored.
INSERT INTO residence_units (floor, letter, tier)
SELECT
  f.floor,
  l.letter,
  CASE WHEN f.floor >= 9 THEN 3 WHEN f.floor >= 5 THEN 2 ELSE 1 END
FROM generate_series(2, 11) AS f(floor)
CROSS JOIN (VALUES ('A'), ('B'), ('C'), ('D'), ('E'), ('F'), ('G'), ('H')) AS l(letter)
ON CONFLICT (floor, letter) DO NOTHING;
