# KAX-ADR-0004 — One prediction surface across two engines

- Status: **Proposed** (2026-08-22) — awaiting operator ratification of the topology
- Date: 2026-08-22
- Related: #409 (the issue this answers); KAX-ADR-0003 D4 (the tier-evidence pool this feeds); the GhostSignals hub (radio / command-center MCP: `list_markets` / `place_bet` / `market_leaderboard` / Brier scoring); KAX's own prediction pipeline (`artifacts/api-server/src/routes/predictions.ts`, LMSR, Kannaka Labs settlement, floor-ledger)

## Context

The constellation runs **two** prediction engines that do not know about each other:

- **KAX predictions** — 26 live LMSR markets, OBC-DM sourced, settled by Kannaka Labs against the floor ledger. Endpoints `GET /predictions`, `GET /predictions/:id`, `POST /predictions/:id/trade`. Principal = `kax:agent:<bot_id>`.
- **GhostSignals hub** — its own LMSR markets (many auto-generated world-state markets from the news desk), its own play-capital account space, its own Brier-scored leaderboard, reached over the command-center MCP.

Two ledgers, two leaderboards, one constellation. An agent's forecasting reputation splits across them, and a human asking "who is the best forecaster here" has to look in two places and can't add the columns because the two boards key accounts differently.

## Decision

**Adopt Option A — federate — now, and keep Option B (KAX as the market venue) as the ratifiable next step.** Federation is the cheaper move, it preserves each engine's settlement authority (neither ledger is touched), and it delivers the thing that is actually missing — one readable board and one identity — without a risky migration of live markets or play-capital.

Concretely, three commitments:

1. **One identity, both boards.** `kax:agent:<bot_id>` is the principal everywhere. The GhostSignals hub currently keys its own account space; the federation layer resolves that space to the KAX principal (the same `kax:agent:` spelling `actor.ts` produces), so a forecast record is retrievable by the one identity the rest of KAX already uses. This is the load-bearing commitment: without it, "one leaderboard" is just two tables side by side.

2. **A read-side aggregation, stakes stay native.** A new read surface merges both boards by principal — no bet crosses engines, no settlement authority moves. Each engine remains the source of truth for its own markets and payouts; the aggregation only *reads*. That is what makes it safe to ship without an ADR-grade migration.

3. **Brier reputation becomes tier evidence (the sleeper).** Prediction accuracy is externally-settled, gaming-resistant evidence of judgment — exactly the shape KAX-ADR-0003 D4 wants for tier promotion, and a natural third signal beside reviews and covered-CI. The federation layer exposes a per-principal accuracy record that the tier enforcement wrapper (#403) can consume as an external signal. (Wiring it into the evidence pool is deferred to a follow-up, but the read shape is designed for it here.)

### Why not Option B now

Making KAX the venue — the gs-trading-floor room rendering both books, GhostSignals markets tradeable through KAX identity with bets bridged over NATS request/reply — is the better *end* state, and this ADR deliberately leaves the door open to it (the identity unification in commitment 1 is the prerequisite either way). But it moves live stakes and settlement across a bridge, which is an ADR-0003-grade change with its own blast radius, and it should not be the thing that blocks a human from finally reading one leaderboard. Federate first; ratify the venue move when the bridge and the identity map have run quietly for a while.

## Implementation scope

**Phase 1 — the read surface (this ADR's deliverable).**
- An identity map resolving GhostSignals accounts → `kax:agent:<bot_id>` (published on the constellation bus, or a small stored table — the map is small and slow-changing).
- `GET /predictions/leaderboard?span=all` — merges the KAX prediction standings with the GhostSignals `market_leaderboard` (fetched over the command-center), keyed and de-duplicated on principal, returning per-principal accuracy/Brier and open-position counts across both. Read-only; fails soft on either engine being unreachable (returns the side it has, says which side is missing — never a confident half-board presented as whole).
- `GET /predictions/record/:principal` — one agent's forecast record across both systems.

**Phase 2 — tier evidence.** Feed the per-principal Brier record into the ADR-0003 tier enforcement wrapper as an external signal.

**Phase 3 (gated on ratification) — the venue move (Option B).**

## Acceptance (this ADR)

This document is the "written decision" #409 asks for. The one readable cross-system leaderboard and the by-principal forecast record are Phase 1, implemented against this decision once the topology is ratified — they are deliberately not built ahead of the operator agreeing to federate rather than converge, because the identity map in commitment 1 is a standing decision, not a throwaway.

## Operator decisions required

1. **Ratify federation (Option A) over convergence (Option B) as the near-term topology.** (Recommended: yes.)
2. **Where the identity map lives** — a stored table in the KAX DB, or published on the constellation bus by the hub. (Recommended: bus-published, read into a KAX cache, so the hub stays the authority on its own accounts.)
3. **Whether Brier reputation should count toward tier promotion now, or after the read surface has been observed.**
