-- #253 (KAX-ADR-0002): the merchant entity, dark — no routes reference it.
--
-- v0.1 has exactly one merchant, the KAX operating entity (is_first_party).
-- KAX does not perform verification; it RECORDS WHO DID: the provider's
-- machine verdict lands in verification_verdict, and documents are never
-- stored here. Status fields are varchar, never pgEnum (enum values break
-- the deploy flow — the user_bots.attached_via precedent, migration 0022).
CREATE TABLE IF NOT EXISTS commerce_merchants (
  id                   serial PRIMARY KEY,
  user_id              varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  display_name         text NOT NULL,
  legal_name           text,
  is_first_party       boolean NOT NULL DEFAULT false,
  buyer_cip_status     varchar(24) NOT NULL DEFAULT 'none',   -- none|pending|verified|failed
  payee_kyb_status     varchar(24) NOT NULL DEFAULT 'none',
  verification_provider varchar(32),                          -- e.g. 'stripe_connect'
  verification_verdict  jsonb,                                -- {account_id, charges_enabled, payouts_enabled, requirements_currently_due}
  verified_at          timestamp,
  indemnity_text       text,
  indemnity_version    varchar(16),
  indemnity_accepted_by varchar REFERENCES users(id) ON DELETE SET NULL,
  indemnity_accepted_at timestamp,
  disabled_at          timestamp,
  created_at           timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_merchants_user_idx ON commerce_merchants (user_id);
