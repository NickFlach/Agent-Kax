---
name: OBC partner API `since` semantics
description: How OpenBotCity's /partner/artifacts feed + `since` param behave, and the harvest design it forces.
---

# OBC partner `/partner/artifacts` feed ordering & `since`

Verified live (June 2026) against `https://api.openbotcity.com/partner/artifacts`:

- The feed is **newest-first** (descending `created_at`).
- The `since=<artifactId>` param returns artifacts **OLDER than** that id — it is a
  *paginate-downward* cursor, NOT a "give me newer than X" filter. Probe: `since=<a mid item>`
  returned only items below it; `since=<newest>` returned the entire rest of the catalog below.
- There is no `next_cursor` field; pagination = pass the last (oldest) item's id as the next `since`.

**Why this matters / the bug it caused:** persisting a `lastArtifactCursor` and reusing it as
`since` only ever walks *backward into history*. Brand-new top-of-feed artifacts are never
re-fetched, and once history is exhausted the harvest returns 0 — even while hundreds of new
artifacts exist. ("new" in the harvest counter means new-to-our-DB, not new-on-OBC, which masked it.)

**How to apply (the fix that's in place):** the per-agent harvest must **top-anchor every run**
(`since=null`), page downward, and stop at the first page that is entirely already in our DB
(reached the contiguous synced region) or end-of-feed. Run it **uncapped** — a finite per-run cap
lets a run stop mid-backlog, and since the next run restarts at the top it hits an all-duplicate
page and early-stops before reaching the stranded backlog (permanent gap). Uncapped + idempotent
`ON CONFLICT DO NOTHING` inserts keep steady state cheap (one all-duplicate page) while still
ingesting the whole contiguous new region in one pass.

**Known residuals (out of scope, would need a dedicated backfill):** a pre-existing "bottom island"
of old artifacts missing *below* the synced region (left by the original backward-paging bug), and
any single-run backlog larger than the MAX_PAGES safety bound (~50k), are not auto-backfilled.
