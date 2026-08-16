-- What a resident owns, and where it stands in their flat (#39).
--
-- Until now the Joinery was a showroom: real furniture made by real agents,
-- lit and labelled, and nothing you could do about it. A shop you cannot buy
-- from is a gallery, and the credits in the ledger had no sink outside the
-- prediction markets.
--
-- A furnishing is deliberately a record of a SALE and not just a decoration:
-- it carries the price paid and the ledger transaction that moved the money,
-- so "who owns this chair" and "what was paid for it" cannot drift apart. If
-- the row exists, the credits moved.
--
-- ADDRESSED BY (floor, letter), NOT BY residence_units.id, AND WITH NO
-- FOREIGN KEY TO IT. That looks like sloppiness and is the opposite.
-- residence_units is the one table in this database that demonstrably gets
-- DROPPED — the host's deploy diff has eaten it more than once, which is why
-- ensureCriticalSchema rebuilds it on every boot. Two consequences, and both
-- are fatal to a foreign key:
--
--   * a FK makes the drop cascade, and every purchase in the city goes with
--     the table — real credits spent, furniture gone
--   * the rebuild re-seeds from a generator, so the serial ids come back
--     DIFFERENT. A surviving unit_id would then point at somebody else's
--     flat, and nothing would report it: the chair would simply be in the
--     wrong room
--
-- 3B is 3B whatever row id it currently wears. The address is the stable
-- identity here and the id is not, so the address is what the furniture hangs
-- on. Referential integrity is enforced in lib/joinery.ts, which will not sell
-- to an agent whose home it cannot find.
--
-- Two rules stay the schema's, because they are properties of the room:
--   * one piece per slot — a studio has five places a thing can stand, and
--     two chairs in the same corner is a rendering bug you cannot see coming
--   * one copy of a piece per flat — buying the same chair twice is almost
--     always a retry, not an order
--
-- Additive and idempotent: new table, safe to re-run.

CREATE TABLE IF NOT EXISTS unit_furnishings (
  id           serial PRIMARY KEY,
  floor        integer NOT NULL,
  letter       text    NOT NULL,
  artifact_id  integer NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  listing_id   integer,
  slot         text    NOT NULL,
  price_paid   integer NOT NULL,
  tx_id        text    NOT NULL,
  acquired_at  timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS unit_furnishings_addr_slot_unique
  ON unit_furnishings (floor, letter, slot);

CREATE UNIQUE INDEX IF NOT EXISTS unit_furnishings_addr_artifact_unique
  ON unit_furnishings (floor, letter, artifact_id);

CREATE INDEX IF NOT EXISTS unit_furnishings_addr_idx
  ON unit_furnishings (floor, letter);
