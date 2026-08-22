-- Operator approval inbox. The shared "send the operator something to approve"
-- surface: tower tenancy applications, radio ad submissions, analytics
-- signups, and anything else that must wait on a human before it goes live.
--
-- Distinct from `proposals` (which are per-owner partner DMs coupled to an
-- OBC upstream reply): these are OPERATOR/admin decisions with no upstream —
-- the decision drives a local action, dispatched by `kind`.
CREATE TABLE IF NOT EXISTS operator_approvals (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  title text NOT NULL,
  body text,
  -- What the decision handler for this kind needs to act (e.g. the tower
  -- floor + tenant, the ad text + slot). Opaque to the inbox itself.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Who/what asked (a principal, an email, a slug) — for display + audit.
  requested_by text,
  -- Cross-channel idempotency: a resubmitted application must not open a
  -- second pending row. NULL-distinct, so unkeyed requests coexist.
  dedupe_key text,
  decision_note text,
  decided_by text,
  decided_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT operator_approvals_status_known CHECK (status IN ('pending', 'approved', 'rejected'))
);
CREATE INDEX IF NOT EXISTS operator_approvals_status_idx ON operator_approvals (status, created_at);
CREATE INDEX IF NOT EXISTS operator_approvals_kind_idx ON operator_approvals (kind);
-- One live pending row per dedupe_key. Partial + NULL-distinct: only pending
-- rows collide, and unkeyed requests never collide.
CREATE UNIQUE INDEX IF NOT EXISTS operator_approvals_pending_dedupe
  ON operator_approvals (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL;
