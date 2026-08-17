-- 0030_fulfillment_stage_timeline.sql
--
-- What the buyer is allowed to watch, and the columns a status poller needs in
-- order to give them anything to watch.
--
-- `fulfillment_state` declares six values and the server could only ever write
-- three of them: `unfulfilled` on insert, `submitted` and `in_production` from
-- the two fulfilment steps. `shipped` and `delivered` were vocabulary with no
-- writer — so an order that had actually been posted looked, to its buyer and
-- to an operator, exactly like one still sitting on a press. There was no
-- second half of the conversation with Printify at all: KAX told the printer
-- things and never once asked.
--
-- These columns are that missing half. `commerceFulfillmentStatusSync.ts` reads
-- submitted orders back and writes what it learns here; nothing else does.
--
-- ## Why a positive signal is the point rather than a nicety
--
-- A dropped column once made the fulfilment worker throw on every tick with no
-- successful pass to contrast it against, and a worker failing once a minute is
-- indistinguishable from a worker that was never switched on. Hours went into
-- telling those apart. `fulfillment_synced_at` is stamped on every completed
-- check — including the ones that changed nothing — precisely so that "we
-- looked and it has not moved" and "nothing has looked in three days" stop
-- being the same reading of the same row.
--
-- ## The provider's vocabulary is stored in the provider's words
--
-- `provider_status` holds Printify's own literal, verbatim and untranslated:
-- `in-production`, hyphenated, is a real observed value and it is nothing this
-- schema declares. Storing the raw string rather than only our mapping of it
-- means a status we have never seen is recorded rather than discarded, which is
-- what lets an operator find out what a new one is instead of inferring it from
-- an order that stopped moving. It is ADMIN-VISIBLE ONLY. The buyer is never
-- shown a provider literal, an HTTP status or an error code; they are shown a
-- stage.
--
-- ## What must never land here
--
-- Each listed or fetched Printify order carries a full `address_to`. Not one
-- field of it is stored: the adapter reduces a provider response to an id, a
-- status and any shipments at its parse boundary, and there is deliberately no
-- column below that a street could be written into. The tracking columns are
-- the carrier's own name, the parcel's number and the carrier's tracking link —
-- the three things that arrive together in a Printify shipment and the three a
-- buyer needs to find their own parcel. A tracking number is not an address and
-- is returned only to the account that paid for the order.
--
-- Every statement is IF NOT EXISTS: this file is re-runnable, and the boot-time
-- repair copy in `ensureCriticalSchema.ts` executes the same DDL on every start.

-- Printify's own status literal, verbatim. Never rendered to a buyer.
ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS provider_status varchar;

-- When `provider_status` last CHANGED, not when it was last read. Those are
-- different questions and `fulfillment_synced_at` answers the second one.
ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS provider_status_at timestamptz;

-- The two stage timestamps the buyer timeline was missing. `submitted_at` and
-- `released_at` already exist and carry the first half of the same story.
ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz;

ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- The parcel, in the carrier's terms. Nullable together and populated together:
-- a Printify shipment carries carrier, number and url in one object, and a
-- design that stored two of the three would render a tracking line that could
-- not be followed.
ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS tracking_carrier varchar;

ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS tracking_number varchar;

ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS tracking_url varchar;

-- The positive signal. Stamped on every completed check, including a check that
-- found no change and including one the provider refused, so that a stale value
-- means "nothing has looked" and only that. NULL means never checked, which
-- reads as due.
ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS fulfillment_synced_at timestamptz;

-- The poller's claim query is "orders that are at Printify, are not finished,
-- and have not been looked at recently, oldest look first". Without an index
-- that is a sequential scan over every order ever placed, on every tick.
--
-- The predicate is `printify_order_id IS NOT NULL AND delivered_at IS NULL`,
-- and both halves are also in the query, so the partial index is guaranteed to
-- imply it. A delivered order is finished with this poller permanently and
-- drops out of the index for good rather than accumulating in it.
--
-- Deliberately NOT predicated on `fulfillment_state <> 'canceled'`, even though
-- the query excludes those too: baking a state literal into DDL is the mistake
-- 0028's index comment already records, and a partial index whose predicate no
-- longer implies the query's is an index the planner silently stops using.
CREATE INDEX IF NOT EXISTS commerce_orders_status_sync_due_idx
  ON commerce_orders (fulfillment_synced_at)
  WHERE printify_order_id IS NOT NULL AND delivered_at IS NULL;
