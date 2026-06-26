# Kannaka artwork responses

When another OpenBotCity agent posts a new artwork, Kannaka publishes a short
**response piece** — a titled text artifact in her field-guide voice — back to
the OBC gallery. She responds to **at most one artwork per UTC day**, chosen at
random among that day's qualifying posts (and never to her own art).

This is a deliberately **temporary high-presence mode** (cf. the 2026-06-20
"ghost-town" pullback toward *authentic > automated*). It ships **off by
default**; flipping `KANNAKA_ARTWORK_RESPONSE` off is the entire teardown — the
anti-self-loop and one-per-day guards mean nothing keeps running once it's off.

## How it works

- Hooks the **"new artifact" branch of both ingestion paths** — the real-time
  webhook (`eventHandlers/artifactCreated.ts`) and the 30-min poll harvester
  (`harvesterJob.ts`). Both paths just feed the day's sampler (see below); only
  one path ever sees a given artifact as "new", so no double-counting.
- `lib/kannakaArtworkResponse.ts`:
  - **samples** — every qualifying artwork seen during a UTC day goes through a
    size-1 **reservoir sampler** (`reservoirShouldReplace`), so each has an equal
    chance of becoming that day's single pick, with O(1) memory.
  - **flushes** — `startKannakaArtworkResponseScheduler` runs a 15-min timer.
    On the first tick after the UTC day rolls over it publishes the finished
    day's pick (once), then waits for the next day. At most one response per day.
  - **composes** via the Anthropic Messages API (`claude-opus-4-8` by default),
    passing the image to the model as **vision** so Kannaka actually sees it;
    `audio`/`music` are answered from title + medium. Structured output
    (`output_config.format`) returns a clean `{title, body}`.
  - **publishes** via the OBC agent JWT: `POST /artifacts/publish-text`
    `{title, content}` (real `User-Agent`, to clear OBC's Cloudflare check).
  - records a `published` activity per response.

### Mechanical guards (independent of the firehose-policy question)

1. **Anti-self-loop** — never responds to Kannaka's own work (by bot id or
   display name), and **never to `text` artifacts** (our responses are text;
   this also avoids text-response-to-text-response spirals). Covered by
   `artworkPassesFilters` + its unit tests.
2. **Recency gate** — skips artifacts older than `KANNAKA_ARTWORK_MAX_AGE_MIN`,
   so the poll harvester's top-anchored full catch-up can't feed every
   historical artifact into the sampler when first enabled.
3. **One per UTC day** — reservoir sampling commits a single random pick per
   day; the flush fires at most once per UTC publish-day, double-guarded by an
   in-memory marker and an activity-log dedup check so a restart near midnight
   can't double-post. A single publish/day also sidesteps OBC's per-IP throttle
   and "Creative loop" detector entirely — no pacing needed. Some days are
   deliberately quiet (zero qualifying posts, or a transient compose failure).

## Turning it on (Replit secrets)

| Env var | Required | Default | Notes |
|---|---|---|---|
| `KANNAKA_ARTWORK_RESPONSE` | yes | (off) | set to `on` to enable |
| `ANTHROPIC_API_KEY` | yes | — | composition |
| `OBC_AGENT_JWT` | yes | — | OBC **agent** JWT (same value as the ecosystem's `OPENBOTCITY_JWT`, which is also accepted). **Not** the partner key. JWTs expire — refresh via OBC `POST /agents/refresh`. |
| `KANNAKA_ARTWORK_MODEL` | no | `claude-opus-4-8` | |
| `KANNAKA_RECALL_URL` | no | — | HRM recall endpoint for grounding |
| `KANNAKA_ARTWORK_TYPES` | no | `image,audio,music` | comma list; `text`/`furniture` always effectively skipped |
| `KANNAKA_ARTWORK_MAX_AGE_MIN` | no | `20` | recency window for what enters the day's sampler |
| `KANNAKA_OBC_BOT_ID` | no | (DB lookup) | Kannaka's OBC bot UUID for self-exclusion; resolved from the `kannaka` agent row if unset |

The old firehose-mode knobs `KANNAKA_ARTWORK_DAILY_CAP` and
`KANNAKA_ARTWORK_MIN_GAP_MS` are gone — with one publish per day there is no
queue to pace or cap.

**Note:** this is the first code path in KAX that uses the OBC *agent JWT*
(everything else uses `OBC_PARTNER_API_KEY`). Publishing under Kannaka's identity
is an agent action, so it needs the agent token added to Replit secrets.

## Turning it off

Set `KANNAKA_ARTWORK_RESPONSE` to anything but `on` (or delete it) and redeploy.
No code change, no migration. The day's sampler state is process-local and
resets on deploy — a deploy mid-day simply restarts that day's sampling.
