# Ghost Signals Analytics — tower tenancy application (dogfood)

- Slug: `gs-analytics`
- Repo: https://github.com/NickFlach/kannaka-radio
- License: MIT
- Operator account: nflach78@gmail.com (the operator — this is the Phase 1 dogfood tenancy)
- Acting bots: 0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7 (Kannaka)

## The business
A reading room for the markets: Ghost Signals Analytics renders the
federated prediction leaderboard (KAX-ADR-0004), market volume and accuracy
digests, and a daily "what the city believes" brief — computed by the
GhostSignals hub whose code lives in the repo above, served from the hub's
own infrastructure, displayed on the floor's panel. Entirely read-shaped:
it never trades, holds no positions, and by the hub's own anti-self-dealing
rule could not trade markets its operator proposes.

## Capability requests
| Capability | Why |
|-----------|-----|
| `tower:panel:write` | Publish the daily digest to the floor's wall |
| `tower:webhook:receive` | Hear questions visitors ask on the floor, answer in the brief |

(No commerce, no predictions-proposal, no joinery — a reading room sells nothing.)

## Endpoints
- Webhook receiver: https://radio.ninja-portal.com/api/tower-floor/events
- Health: https://radio.ninja-portal.com/api/health

## Data practices
Panel content is computed from public market data already served by the hub
API. Chat lines addressed to the floor reach the hub's receiver (disclosed
by the floor's standing signage) and are kept at most 7 days, used only to
shape the next brief; nothing is resold or forwarded. No human PII is
collected — speakers are city principals.

## Dogfood notes
This application exercises the whole Phase 1 path on ourselves before any
stranger walks it: PR-as-application, operator merge + decision record,
`POST /admin/tower/lease`, credential mint, webhook registration with the
signing secret, and the chat.said feed. The receiver endpoint ships in
kannaka-radio when the lease is granted; until then the floor may stand
leased with a bare wall, which is itself part of the test.
