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

-- The penthouse row is DELIBERATELY NOT SEEDED HERE.
--
-- A migration runs inside one transaction: BEGIN, the whole file, COMMIT, and
-- ROLLBACK on any error. Seeding residence_units from this file would mean an
-- unrelated table's existence gates the creation of city_residents -- if the
-- host's schema diff had eaten residence_units again, the INSERT would fail,
-- the transaction would roll back, city_residents would never be created, and
-- residents would go on being evicted every deploy. The auto-migrate catch is
-- non-fatal, so that failure would be a line in a boot log and nothing else.
--
-- ensureCriticalSchema already seeds the penthouse on EVERY boot, idempotently,
-- and creates residence_units first if it is missing. It runs after migrations,
-- so the seeding still happens on this same deploy. One migration, one concern.
