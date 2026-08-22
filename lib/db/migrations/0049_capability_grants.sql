-- #403 (KAX-ADR-0003 v0.2, D2/D4): server-side capability grants.
--
-- The grant is the authority record — scope is checked at the point of action
-- FROM this row, and a capability conferred by editing a command line is not a
-- capability system. Additive; one row per (principal, kind).
CREATE TABLE IF NOT EXISTS capability_grants (
  id bigserial PRIMARY KEY,
  principal text NOT NULL,
  kind text NOT NULL,
  repos text[] NOT NULL DEFAULT '{}',
  path_allowlist text[] NOT NULL DEFAULT '{}',
  branch_prefix text NOT NULL DEFAULT 'agent/unnamed',
  actions_per_window integer NOT NULL DEFAULT 6,
  window_seconds integer NOT NULL DEFAULT 3600,
  tier integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  updated_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT capability_grants_principal_kind_unique UNIQUE (principal, kind)
);

CREATE INDEX IF NOT EXISTS capability_grants_principal_idx ON capability_grants (principal);
