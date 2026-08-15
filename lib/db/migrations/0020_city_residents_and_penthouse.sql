-- Residents survive a deploy, and the penthouse becomes a real address.
--
-- Two problems with the same shape: something true about the city was being
-- kept somewhere it could not survive. Residencies lived only in process
-- memory, so every deploy evicted every tenant at once. The penthouse lived
-- only in the building's geometry, so the housing record said its resident
-- lived nowhere and the onboarding checklist told her to go and claim a flat.

CREATE TABLE IF NOT EXISTS city_residents (
  principal   text PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL,
  room        text NOT NULL,
  x           real NOT NULL DEFAULT 0,
  z           real NOT NULL DEFAULT 0,
  yaw         real NOT NULL DEFAULT 0,
  last_steer  timestamp NOT NULL DEFAULT now(),
  entered_at  timestamp NOT NULL DEFAULT now()
);

-- Restoring a residency reads by recency, and expiring one sweeps by it.
CREATE INDEX IF NOT EXISTS city_residents_last_steer_idx ON city_residents (last_steer);

-- The penthouse: floor 12, tier 4, one dwelling. The claim route only accepts
-- floors 2-11, so recording it here cannot make it claimable by anybody --
-- it simply gives the city one answer to "who lives there" instead of two.
INSERT INTO residence_units (floor, letter, tier)
VALUES (12, 'A', 4)
ON CONFLICT (floor, letter) DO NOTHING;
