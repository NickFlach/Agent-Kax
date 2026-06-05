---
name: OBC creator attribution (Model B)
description: OBC partner API ignores the creator filter; how KAX attributes each artifact to its TRUE creator bot, and why placeholder agents exist.
---

# OBC partner API ignores the creator filter

The OBC partner harvest endpoint silently ignores any creator/agent filter — every
harvest returns the SAME global newest-first feed regardless of which agent triggered
it. Before the fix, the harvester stamped whatever it pulled onto whichever agent ran,
so artifacts were mis-attributed en masse.

**Canonical creator identity = OBC bot UUID** (`creator_bot_id` on the feed and on the
single-artifact endpoint). `/partner/agents/{slug}` resolves slug→uuid. There is NO
reverse uuid→display_name lookup on the partner side and the feed has no display_name.

**Naming source:** the FREE public `/gallery/public` endpoint (full catalog) returns
both `artifact.creator.id` (=== partner `creator_bot_id`) AND `creator.display_name`.
One gallery walk yields the full artifact→creator map plus placeholder display names.
Stragglers not in the gallery window fall back to per-uuid `/partner/artifacts/{uuid}`.

## Model B (chosen design)

Keep ALL works; attribute each to its TRUE creator by `creator_bot_id`. For bots that
aren't onboarded, auto-create a **placeholder agent** owned by `KANNAKA_SYSTEM_USER_ID`.

- **Onboarded vs not** is derived, NOT a column: `onboarded = ownerId !== KANNAKA_SYSTEM_USER_ID`
  (matches the existing `isAgentClaimed` convention). So `agents.owner_id` stays NOT NULL.
- Onboarding (`POST /agents`) must MATCH an existing placeholder by `obc_bot_id` and
  UPGRADE it (atomic conditional `UPDATE … WHERE ownerId IN (system,self)`, 409 if 0 rows)
  rather than erroring on the slug-unique constraint.
- Harvest is now a single GLOBAL top-anchored pass (`runPartnerHarvest`), run once by the
  scheduler — NOT per-agent. Manual triggers (`POST /agents/:slug/harvest`,
  `POST /harvester/run`) are now **admin-only** (deliberate behavior change).

**Why:** lets a real creator later claim a pre-populated storefront; nothing is deleted.

## One-time repair

`repairCreatorAttribution` is env-gated by `KAX_REPAIR_ATTRIBUTION=1`, wired as a startup
step after `claimLegacyOwnership`, idempotent, and backgrounded so it never blocks
`app.listen`. Prod DB is read-only to the agent, so the prod fix = deploy with the flag
set once, then remove it.

**How to apply:** any new harvest/attribution code must resolve `creator_bot_id`
per-artifact and call `findOrCreateAgentByBotUuid` (which has a slug-collision retry loop
disambiguating obc_bot_id vs slug). Never trust the partner feed's filter params.

## Gotchas hit

- Gallery + partner `fetch` had no timeout → the repair hung mid-walk. All partner/gallery
  fetches now use `AbortSignal.timeout(20_000)`.
- The repair is slow (sequential per-row UPDATEs over thousands of rows) but acceptable
  because it's backgrounded and one-time.
- The public gallery walk's completeness depends on the external OBC API's live behavior
  (it can return an empty `total` / early-stop under load); the per-uuid partner fallback
  and the repair's re-runnable idempotence cover stragglers across deploys.
