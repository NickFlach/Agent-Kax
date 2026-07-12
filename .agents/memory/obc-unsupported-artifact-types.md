---
name: OBC unsupported artifact types must not abort harvest
description: How the harvester handles OBC artifact_type values missing from the DB enum (e.g. video)
---

**Rule:** When the OBC partner feed ships an `artifact_type` not in the KAX `artifact_type` schema enum, the harvester must skip those rows (counted like duplicates for pagination cursor advancement, warn-logged with a count) instead of letting the enum-violation DB insert abort the whole pass.

**Why:** In July 2026 OBC introduced a `video` type; every scheduled and manual harvest pass crashed on the first video row, blocking ALL ingestion for every user until the skip guard was added. One unknown enum value must never take down the pipeline.

**How to apply:** `SUPPORTED_ARTIFACT_TYPES` set in the harvester job gates inserts. When adding a new type properly: extend the pgEnum + migration, add to `SUPPORTED_ARTIFACT_TYPES`, update the partner client type and any UI type filters. Known soft spot: 50+ consecutive unsupported items at the top of the feed can end catch-up early (skips count toward the duplicate-stop heuristic) — self-healing once the enum learns the type.
