-- 0028_fulfillment_worker_state.sql
--
-- The four columns an automatic fulfilment worker needs in order to be
-- restartable, and nothing else.
--
-- Fulfilment was a manual admin action by design (ADR-0002, #287): the window
-- between submit and release is where a human's eyeballs are the address
-- validator and the fraud check. That decision stands and the two endpoints
-- stay; what this adds is an OPT-IN worker that presses the same two buttons on
-- a timer, and a worker that retries needs somewhere durable to keep "how many
-- times, when last, when next, and what the provider said".
--
-- In-memory state would not survive the restart that a retry loop exists to
-- outlive, and would let two instances each keep their own private count.
-- These live on the order row so the budget is the order's, not the process's.
--
-- `fulfillment_last_error` is provider STATUS AND CODE ONLY -- e.g. '429:8251'.
-- Never a response body. Printify's 4xx bodies quote the offending field back,
-- which on this path is the buyer's street, and `printifyClient.ts` already
-- drops that detail at the adapter boundary; this column must not be the place
-- it reappears and gets read out by a listing endpoint.
--
-- Every statement is IF NOT EXISTS: this file is re-runnable, and the boot-time
-- repair copy in `ensureCriticalSchema.ts` executes the same DDL on every start.

ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS fulfillment_attempts integer NOT NULL DEFAULT 0;

-- Provider status + code, e.g. '429:8251'. NEVER a body, never an address.
ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS fulfillment_last_error varchar;

ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS fulfillment_last_attempt_at timestamptz;

-- NULL means "due now". A first attempt is never held back by this column.
ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS fulfillment_next_attempt_at timestamptz;

-- The worker's claim query, on both passes, is "rows whose next attempt is due,
-- oldest id first". Without an index that is a sequential scan over every order
-- ever placed, once a minute, forever.
--
-- Partial on `released_at IS NULL` because a released order is finished with
-- this worker permanently: it drops out of the index for good rather than
-- accumulating in it. The predicate is deliberately NOT `fulfillment_attempts <
-- N` even though the claim query filters on that too -- baking the code's
-- attempt ceiling into DDL would mean raising the ceiling silently invalidates
-- the index, and a partial index whose predicate no longer implies the query's
-- is an index the planner stops using with nothing to say so.
CREATE INDEX IF NOT EXISTS commerce_orders_fulfillment_due_idx
  ON commerce_orders (fulfillment_next_attempt_at)
  WHERE released_at IS NULL;
