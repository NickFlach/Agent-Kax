-- Per-event-type replay cursors (#67).
--
-- Startup replay tracked one global `last_event_uuid` across every event type.
-- It is advanced and persisted per event, so by the time the loop reached the
-- second type the cursor already sat at wherever the first type's stream ended
-- — backlog for later types (dm.received, proposal.created) was skipped, and
-- the skip was persisted, so restarting did not recover it.
--
-- Additive and idempotent: a new nullable column, no backfill. Existing rows
-- get NULL, which the reader treats as "no per-type position recorded yet" and
-- falls back to `last_event_uuid`, so the first run after deploy resumes from
-- exactly where the old cursor left off instead of replaying from zero.
--
-- `last_event_uuid` is retained: /admin and /dashboard surface it, and it stays
-- the "most recently processed overall" marker.

ALTER TABLE partner_sync_state
  ADD COLUMN IF NOT EXISTS event_cursors jsonb;
