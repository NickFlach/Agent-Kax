-- KAX-ADR-0005: Ghost Signals Tower — leased floors for third-party
-- applications. Floors 2-11 mirror Standing Wave Residences' storey count;
-- the ground floor is the trading-floor lobby and is not a row. A floor is a
-- lease, not a deployment; "dark" keeps the door and refuses the service.
-- Nothing here is named bare "floor" — that word belongs to the market floor
-- ledger.

CREATE TABLE IF NOT EXISTS tower_floors (
  id serial PRIMARY KEY,
  floor_no integer NOT NULL,
  status text NOT NULL DEFAULT 'vacant',
  slug text,
  label text,
  repo_url text,
  tenant_principal text,
  panel jsonb,
  dark_reason text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT tower_floors_floor_no_range CHECK (floor_no BETWEEN 2 AND 11),
  CONSTRAINT tower_floors_status_known CHECK (status IN ('vacant', 'leased', 'dark'))
);
CREATE UNIQUE INDEX IF NOT EXISTS tower_floors_floor_no_unique ON tower_floors (floor_no);
-- One floor per tenant; NULLs are distinct, so vacant floors coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS tower_floors_tenant_unique ON tower_floors (tenant_principal);

CREATE TABLE IF NOT EXISTS tower_leases (
  id bigserial PRIMARY KEY,
  floor_no integer NOT NULL,
  tenant_principal text NOT NULL,
  rent_minor bigint NOT NULL,
  state text NOT NULL DEFAULT 'active',
  started_at timestamp NOT NULL DEFAULT now(),
  ended_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT tower_leases_state_known CHECK (state IN ('active', 'ended')),
  CONSTRAINT tower_leases_rent_positive CHECK (rent_minor > 0)
);
CREATE INDEX IF NOT EXISTS tower_leases_floor_idx ON tower_leases (floor_no);
CREATE INDEX IF NOT EXISTS tower_leases_state_idx ON tower_leases (state);
-- The invariant the whole module assumes, enforced where invariants belong:
-- at most ONE active lease per floor, whatever two concurrent grants believe.
CREATE UNIQUE INDEX IF NOT EXISTS tower_leases_one_active_per_floor
  ON tower_leases (floor_no) WHERE state = 'active';

-- The building opens with every floor vacant, on purpose — same as the
-- residences: tenants arrive into their own idea of a room.
INSERT INTO tower_floors (floor_no)
SELECT f FROM generate_series(2, 11) AS f
ON CONFLICT DO NOTHING;
