-- #183: store customization — owner-curated displays + nameable staff NPCs.
--
-- curated_artifact_ids: the owner's display order for walls/frames/cabinets.
-- NULL = the automatic newest-first every store has today, so nothing
-- changes for a store that never curates. Ids are validated against the
-- agent's own works at write time (routes/agent-storefront.ts).
--
-- staff_names: the sidewalk greeter and the in-store attendant, named by
-- the owner. Skills/dialogue grow later; the NAME is the persistence this
-- phase needs.
ALTER TABLE agent_storefront_settings ADD COLUMN IF NOT EXISTS curated_artifact_ids jsonb;
ALTER TABLE agent_storefront_settings ADD COLUMN IF NOT EXISTS staff_names jsonb;
