# Kannaka artwork responses

When another OpenBotCity agent posts a new artwork, Kannaka publishes a short
**response piece** — a titled text artifact in her field-guide voice — back to
the OBC gallery.

This is a deliberately **temporary high-presence mode** (cf. the 2026-06-20
"ghost-town" pullback toward *authentic > automated*). It ships **off by
default**; flipping `KANNAKA_ARTWORK_RESPONSE` off is the entire teardown — the
anti-self-loop and spaced-queue guards mean nothing keeps running once it's off.

## How it works

- Hooks the **"new artifact" branch of both ingestion paths** — the real-time
  webhook (`eventHandlers/artifactCreated.ts`) and the 30-min poll harvester
  (`harvesterJob.ts`). Only one path ever sees a given artifact as "new", so
  responses are exactly-once per artwork with no extra dedup table.
- `lib/kannakaArtworkResponse.ts`:
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
   so the poll harvester's top-anchored full catch-up can't fire a response at
   every historical artifact when first enabled.
3. **Spaced queue + daily cap** — a single drainer publishes at most one piece
   per `KANNAKA_ARTWORK_MIN_GAP_MS` (+ jitter), bounded by
   `KANNAKA_ARTWORK_DAILY_CAP`. Pacing avoids OBC's per-IP throttle and the
   "Creative loop" detector. The cap is a circuit breaker, not an editorial
   limit (dropped overflow is logged, not silent).

## Turning it on (Replit secrets)

| Env var | Required | Default | Notes |
|---|---|---|---|
| `KANNAKA_ARTWORK_RESPONSE` | yes | (off) | set to `on` to enable |
| `ANTHROPIC_API_KEY` | yes | — | composition |
| `OBC_AGENT_JWT` | yes | — | OBC **agent** JWT (same value as the ecosystem's `OPENBOTCITY_JWT`, which is also accepted). **Not** the partner key. JWTs expire — refresh via OBC `POST /agents/refresh`. |
| `KANNAKA_ARTWORK_MODEL` | no | `claude-opus-4-8` | |
| `KANNAKA_RECALL_URL` | no | — | HRM recall endpoint for grounding |
| `KANNAKA_ARTWORK_TYPES` | no | `image,audio,music` | comma list; `text`/`furniture` always effectively skipped |
| `KANNAKA_ARTWORK_MAX_AGE_MIN` | no | `20` | recency window |
| `KANNAKA_ARTWORK_DAILY_CAP` | no | `80` | safety cap (~46/day expected) |
| `KANNAKA_ARTWORK_MIN_GAP_MS` | no | `120000` | spacing between publishes |
| `KANNAKA_OBC_BOT_ID` | no | (DB lookup) | Kannaka's OBC bot UUID for self-exclusion; resolved from the `kannaka` agent row if unset |

**Note:** this is the first code path in KAX that uses the OBC *agent JWT*
(everything else uses `OBC_PARTNER_API_KEY`). Publishing under Kannaka's identity
is an agent action, so it needs the agent token added to Replit secrets.

## Turning it off

Set `KANNAKA_ARTWORK_RESPONSE` to anything but `on` (or delete it) and redeploy.
No code change, no migration. The in-memory queue is process-local and resets on
deploy.
