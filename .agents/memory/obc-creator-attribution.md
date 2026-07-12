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
  `POST /harvester/run`) are open to any signed-in user as of July 2026, guarded by
  budget headroom, a 10-min non-admin cooldown, and a single-flight join (concurrent
  triggers share one run; responses are owner-scoped via `perOwnerNew`). The
  registry fallback and cross-owner audio pairing remain admin-only.

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
- The public gallery walk's completeness depends on the external OBC API's live behavior
  (it can return an empty `total` / early-stop under load); the per-uuid partner fallback
  and the repair's re-runnable idempotence cover stragglers across deploys.

## Deepest flaw: a multi-minute walk MUST persist progress per page, not buffer-then-write

The catalog is ~1015 pages (gallery returns a hard **12 items/page**, ignores `limit`;
total ≈ 12,177). A full walk takes several minutes. The repair USED to call
`buildFullCreatorDirectory()` — which buffers the ENTIRE map in memory and only returns
after the whole walk — then update rows. So when back-to-back task-merge redeploys each
restarted the process mid-walk, the in-memory map was discarded and **zero rows were
written** (prod stuck at ~180/12,176 attributed across several deploys, with NO "Built
creator directory" / "complete" log lines — only `resolveOnboardedAgentBotIds` ran).

**Fix:** the repair now drives the walk itself via `walkPublicGallery()` (async generator)
and stamps matching local rows **per page**, so a partial walk still persists thousands of
rows and a restart resumes (`creator_bot_id IS NULL` skips done rows). `attributeUuid` does
a cheap existence check (gates placeholder-agent creation to creators we actually hold) then
a single set-based `UPDATE … RETURNING`. `getCachedCreatorInfo(botId)` supplies names from
the per-page `nameCache`. `buildFullCreatorDirectory` is kept but no longer used by the repair.

**Why:** for any long external-API + bulk-DB background job, in-memory accumulation before
the first write turns every interruption into total data loss. Write incrementally and make
each unit idempotent so progress compounds across restarts/redeploys.

**Also:** the gallery is NOT always rate-limiting — a fresh probe (many rapid 100-offset
pages) returned all 200s, no 429. The earlier 429 wall was transient/contention; keep the
backoff+pacing, but a stale "always 429s after 240 items" assumption is wrong. Phase-2
straggler lookup is `ORDER BY id LIMIT 2000`; permanently-unresolvable rows (e.g. non-OBC
huggingface artifacts, or works pulled from the gallery) stay NULL by design.

## Prod failure: the repair must survive 429s AND DB pool timeouts (else it does ~nothing)

First prod run fixed only 147 of ~12k rows, then aborted. Two compounding causes, both now fixed:
1. **The public gallery aggressively rate-limits (HTTP 429)** — it returns only ~12 artifacts
   per page (ignores `limit=100`) and 429s after ~240 items. The old `fetchGalleryPage` threw
   on the first 429, so `buildFullCreatorDirectory` stopped the entire walk → creator map had
   240/12k entries → almost nothing resolved.
2. **A single DB connection-pool timeout aborted the whole step.** The long sequential sweep
   under live traffic exhausted the pool; one "Connection terminated due to connection timeout"
   inside `findOrCreateAgentByBotUuid` threw all the way out of `repairCreatorAttribution`.

**Rules for any long external-API + bulk-DB background job here (`**Why:**` above):**
- `fetchGalleryPage` must retry 429/5xx/network with exponential backoff honoring `Retry-After`;
  pace the walk (~300ms/page). Only non-retryable 4xx fails fast.
- The repair must be **resumable**: select only `creator_bot_id IS NULL` so every UPDATE shrinks
  the work set, partial runs compound across boots, and a completed run is a no-op.
- **Per-row try/catch** + a `withDbRetry` wrapper (retries transient connection errors by message
  heuristic) so one DB hiccup is counted and skipped, never fatal. Cap per-uuid partner lookups
  per run (2000) so stragglers can't exhaust the partner budget in one boot.
- It converges across redeploys; it does NOT have to finish in one boot.
