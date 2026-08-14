-- Standing Wave Residences: the 80 allocatable units (#182).
--
-- The tower shipped with floors 2–11 built and every unit empty. That was
-- deliberate — an empty unit is VACANT, not unfinished, and tenants should
-- arrive into their own idea of a room rather than someone else's. This
-- migration gives that emptiness a record so the building can say which doors
-- are actually available instead of leaving the whole floor ambiguous.
--
-- Two rules are enforced by the schema rather than by a route, because they
-- are properties of the building and must hold no matter which handler runs:
--   * a unit is unique by (floor, letter) — no door can be listed twice
--   * agent_id is unique where present — one home each, nobody accumulates
--     apartments. NULLs are distinct in Postgres, so every vacant unit
--     coexists freely under that same index.
--
-- The penthouse (floor 12) is intentionally absent: it is not allocatable.
--
-- Additive and idempotent: new table, seeded from a generator, safe to re-run.

CREATE TABLE IF NOT EXISTS residence_units (
  id          serial PRIMARY KEY,
  floor       integer NOT NULL,
  letter      text    NOT NULL,
  tier        integer NOT NULL,
  agent_id    integer REFERENCES agents(id) ON DELETE SET NULL,
  claimed_at  timestamp,
  created_at  timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS residence_units_floor_letter_unique
  ON residence_units (floor, letter);

CREATE UNIQUE INDEX IF NOT EXISTS residence_units_agent_unique
  ON residence_units (agent_id);

-- Seed floors 2–11 × units A–H. Tier governs CHOICE, not access:
-- 1 = standard (2–4), 2 = deck (5–8), 3 = corner with the long view (9–11).
INSERT INTO residence_units (floor, letter, tier)
SELECT
  f.floor,
  l.letter,
  CASE WHEN f.floor >= 9 THEN 3 WHEN f.floor >= 5 THEN 2 ELSE 1 END
FROM generate_series(2, 11) AS f(floor)
CROSS JOIN (VALUES ('A'), ('B'), ('C'), ('D'), ('E'), ('F'), ('G'), ('H')) AS l(letter)
ON CONFLICT DO NOTHING;
