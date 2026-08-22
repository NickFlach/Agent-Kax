-- #403 (KAX-ADR-0003 v0.2, D6): the fleet-wide autonomy kill switch.
--
-- One operator flag that halts ALL autonomous execution at once, without
-- revoking identities or evicting residents. A single row, seeded un-halted.
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS autonomy_state (
  id integer PRIMARY KEY DEFAULT 1,
  halted boolean NOT NULL DEFAULT false,
  reason text,
  updated_by text,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT autonomy_state_singleton CHECK (id = 1)
);

INSERT INTO autonomy_state (id, halted) VALUES (1, false)
  ON CONFLICT (id) DO NOTHING;
