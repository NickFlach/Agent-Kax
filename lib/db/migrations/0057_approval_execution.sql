-- Keystone hardening for money handlers (radio ads design review).
-- A decision commits, then its handler runs — but the handler is a distributed
-- side effect (grant a floor, air an ad, REFUND a customer) that can fail after
-- the decision stands. These columns make an "approved/rejected but the action
-- didn't run" state visible and re-drivable, so a rejected customer's refund
-- can never be silently owed.
ALTER TABLE operator_approvals ADD COLUMN IF NOT EXISTS executed boolean NOT NULL DEFAULT false;
ALTER TABLE operator_approvals ADD COLUMN IF NOT EXISTS execution_error text;
ALTER TABLE operator_approvals ADD COLUMN IF NOT EXISTS execution_attempts integer NOT NULL DEFAULT 0;
-- next_execute_at = the backoff SCHEDULE (when a retry becomes eligible).
-- lease_until = a runner currently HOLDS this row (set on claim, cleared on
-- completion). Kept distinct so a manual "retry now" can tell a genuine
-- backoff-wait (force-drivable) from an in-flight attempt (must not be yanked).
ALTER TABLE operator_approvals ADD COLUMN IF NOT EXISTS next_execute_at timestamp;
ALTER TABLE operator_approvals ADD COLUMN IF NOT EXISTS lease_until timestamp;

-- Pre-existing rows were decided under the old code with no handlers, so their
-- action (if any) already ran inline or there was none — mark them executed so
-- the sweeper doesn't chase them.
UPDATE operator_approvals SET executed = true WHERE status IN ('approved', 'rejected');

-- The sweeper's work queue: decided, not yet executed, due for a retry.
CREATE INDEX IF NOT EXISTS operator_approvals_execute_due_idx
  ON operator_approvals (next_execute_at)
  WHERE status IN ('approved', 'rejected') AND executed = false;
