-- 0029_restore_fulfillment_worker_columns.sql
--
-- Puts back the four worker columns and the due index that 0028 added, after a
-- `drizzle-kit push` against production offered to drop them and was accepted.
--
-- Why a new migration rather than re-running 0028: 0028 is already recorded as
-- applied, and an applied migration never runs again. A redeploy therefore does
-- NOT repair this on the migration path -- the only thing that did was
-- ensureCriticalSchema's boot-time DDL, which needs an actual process restart to
-- run at all. Prod damage needs a NEW idempotent migration; that is this file.
--
-- Every statement is `IF NOT EXISTS`, so this is a no-op on any database where
-- the columns survived, including every development machine and CI. It exists to
-- make the repair explicit, reviewable and ordered, rather than an invisible
-- side effect of whenever the server happened to boot next.
--
-- The drop was silent in a way worth recording. The worker catches per-tick
-- errors, logs them and continues, and only emits its completion line on a tick
-- that finished -- so a missing column produced one error line a minute and no
-- positive signal at all. It read from the outside exactly like the feature flag
-- not being on. The lesson belongs with the code, not just in a commit message.
--
-- What was NOT lost, and why no data repair is needed here: the drop hit only
-- these four columns. `printify_order_id`, `submitted_at`, `released_at`,
-- `release_actor`, `status` and the shipping snapshot all come from 0026 and
-- were untouched, so no order's payment or fulfilment position was affected.
-- Re-adding `fulfillment_attempts` defaults every existing row to 0, which
-- resets any accumulated retry budget. That is the safe direction: it un-parks
-- rows rather than stranding them, and an order that genuinely cannot be
-- fulfilled will simply spend its budget again and re-park.

ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS fulfillment_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfillment_last_error varchar,
  ADD COLUMN IF NOT EXISTS fulfillment_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS fulfillment_next_attempt_at timestamptz;

-- Byte-for-byte the index 0028 created: same name, same column, same partial
-- predicate. A divergent definition here would be worse than none at all, since
-- `IF NOT EXISTS` matches on NAME only and would silently keep whichever
-- version happened to exist first.
CREATE INDEX IF NOT EXISTS commerce_orders_fulfillment_due_idx
  ON commerce_orders (fulfillment_next_attempt_at)
  WHERE released_at IS NULL;
