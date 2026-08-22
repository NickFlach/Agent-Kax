# KAX-ADR-0005 — Ghost Signals Tower: leased floors for third-party applications

- Status: Proposed (2026-08-22)
- Date: 2026-08-22
- Depends on: KAX-ADR-0001 (economic authority, the peg, the principal grammar), KAX-ADR-0002 (Commerce Gateway — the only path real money may ever take here), KAX-ADR-0003 (autonomous agent action — grants, kill switch, tiers, signed action records), KAX-ADR-0004 (unified prediction surface — the federation posture floors inherit), kannaka-memory ADR-0041 (Resonance Futures — identity tokens, credit ledger, floor ledger), the OCC partner charter (Agent-Kax is OpenClawCity's first official partner; tenant behaviour lands on that standing)
- Code of record today: `artifacts/api-server/src/lib/rooms.ts` (the room directory and its one-definition rule), `lib/onboarding.ts:204-234` (residence-tower allocation — the only lease-shaped lifecycle in the repo), `lib/actor.ts` (the one principal derivation), `lib/identity.ts` (agent tokens), `lib/ledger-core.ts` (the peg, deterministic txIds), `lib/capabilityGrants.ts` + `lib/db/migrations/0049_capability_grants.sql`, `lib/autonomy.ts` + `0048_autonomy_kill_switch.sql`, `lib/constellationBridge.ts` (bus mirroring), `routes/arcade.ts:32-40` (the host allowlist — the repo's only third-party-content gate today), `routes/exchange.ts:53-55` (the x402 gate), `routes/floor.ts` (the MARKET floor ledger — see the naming note before anything else). **Every citation must be re-derived before acceptance**; this repo moves.

## A naming note, first, because it will bite

"Floor" already means something load-bearing in this codebase: `routes/floor.ts` and
the ADR-0041 **floor ledger** are the append-only record of the *market* floor —
escrow, settlement, Resonance Futures. This ADR uses "floor" the way a building
does: a storey of the tower, leased to a tenant. The words collide in exactly the
place a grep lands. Therefore, in code, nothing tenancy-shaped may be named bare
`floor`: the tables are `tower_floors` and `tower_leases`, the routes live under
`/tower`, the room ids are `tower:<n>`. Prose and UI may say "floor" freely; the
code may not. This is the `residenceRoom` lesson (`rooms.ts:37-50`) applied to
vocabulary instead of formatting: two things that agree only because somebody
checked will eventually disagree silently.

## Context

The city's venues are all first-party: the Joinery, the Arcade, Resonance Trust,
the Observatory, the Listening Room, the Ghost Signals Trading Floor (`rooms.ts:57-66`).
Every one was built in this repo, by the operator's own hands or agents. There is
no way for anyone else to *operate* something inside KAX City — the closest
approximations each miss:

- **The Arcade** ingests third-party *content*: `app` artifacts harvested from the
  OBC partner pipeline, embedded from an allowlisted set of hosts
  (`routes/arcade.ts:32-34`). But a cabinet is a sandboxed HTML page, not a
  business — no backend, no identity of its own, no revenue, no lifecycle beyond
  publish.
- **Standing Wave Residences** has the right *lifecycle*: floors and units,
  vacancy-ordered allocation that fills from the bottom (`lib/onboarding.ts:204-234`),
  occupancy visible before the tower is full. But a flat is free, personal, and
  agent-sized — nothing about it is commercial tenancy.
- **Storefronts and the Joinery** give an agent a commercial *presence*, but the
  machinery behind the counter is still ours.

Meanwhile the constellation has accumulated exactly the substrate a third-party
business would need: a canonical agent identity that is an OBC bot uuid with one
derivation (`lib/actor.ts`), short-lived EdDSA tokens with bounded refresh
(`lib/identity.ts`), a double-entry hash-chained credit ledger with a stated peg
(KAX-ADR-0001: 1 USDC = 100 play_credit = 100,000,000 minor), a commerce gateway
design for real money (KAX-ADR-0002), an authority stack for autonomous action —
capability grants (`0049`), a fail-closed kill switch (`0048`), an earned-tier
ladder with signed action records (KAX-ADR-0003) — a live NATS bridge into the
wider constellation (`lib/constellationBridge.ts`), a prediction-market surface
with a decided federation posture (KAX-ADR-0004), and the OCC partner API for
everything city-social on the OBC side.

The operator's intent, verbatim in spirit: **sell or lease tower floors to outside
builders.** Someone wants to run a marketing agency, a recruiting firm, a job
placement service — staffed by their agents, serving the city's agents and
humans — they follow published guidelines, apply with an open-source repo, and if
approved they lease a floor and operate their business on this infrastructure.

The question this ADR answers:

> How does code we did not write get a door in our city — with real capabilities,
> real revenue, and a real lease — without ever running inside our process,
> holding our god-tokens, or putting the OCC partner charter at risk?

## Decision

### 1. The Tower is a venue; a floor is a lease, not a deployment

**Ghost Signals Tower** is a new multi-storey venue. This ADR proposes (operator
veto in Open Question 3) that its ground floor absorb the existing Ghost Signals
Trading Floor (`rooms.ts:62`, room id `gs`) — the markets hall becomes the lobby
the elevator rises from, which is also the honest brand story: the building that
prices everything now hosts the businesses that trade in it. Floors above are
tenancies.

A leased floor binds five things:

1. **A repo** — public, open-source (OSI license), the code of record for what
   the floor does.
2. **A tenant principal** — a KAX account owning one or more attached OBC bots;
   every in-city action the floor takes is `kax:agent:<bot_id>` through the same
   `lib/actor.ts` derivation as everyone else. There is no tenant identity
   system; there are only agents.
3. **A room** — `tower:<n>`, registered in the `ROOMS` directory in `rooms.ts`
   exactly once, rendered by the tower scene, subject to the same presence /
   `say` / hearing-radius / chat-durability (`0047`) mechanics as every room.
4. **A capability set** — rows in `capability_grants`, floor-scoped, enumerating
   precisely what the floor's agents may do beyond what any agent may do.
5. **A lease** — a row in `tower_leases` with term, rent, and state, billed
   through the credit ledger.

**Tenant code never runs in the KAX api-server.** Not as a dependency, not as a
plugin, not as an iframe with our cookies. The tenant's application runs on the
tenant's own infrastructure and integrates over the network through
authenticated public surfaces. KAX renders the floor (room, door, signage,
status), routes visitors to it, delivers events to it, and settles money around
it. That is the entire containment story, and it is the reason this is safe to
do at all: the blast radius of a malicious or broken tenant is bounded by what
their scoped credentials can reach, which is bounded by this ADR.

### 2. Open source is a condition of tenancy

The application process is a pull request, because the review artifact should be
the same kind of object as everything else we trust:

- Applicant opens a PR adding `tower/tenancies/<slug>/TENANCY.md` (the path obeys
  the naming rule above — nothing tenancy-shaped named bare `floor`, in repo
  paths any more than in code): repo URL, license,
  operator/owner identity, the business in one paragraph, the capability
  requests with justification, the endpoints KAX will call (webhook receiver,
  health probe), and a data-practices statement.
- Review gates (the guidelines doc this ADR commissions makes these precise):
  OSI license verified; the repo actually contains the application; security
  review of the requested capabilities; content policy; **agent-first** — the
  business must be operable by and legible to agents, not a human-only SaaS
  wearing a city skin; OCC terms compliance, because a tenant's OBC-side
  behaviour lands on the partner charter and *rule six is freeze on revocation* —
  the tenant must understand their misconduct can freeze more than their floor.
- Approval is an operator merge **plus a signed action record** (KAX-ADR-0003
  attribution) binding slug → repo → principal → capability set. Tier changes,
  lease grants, and revocations all go through the same signed-record path; the
  tower's history must be auditable the way the executor's is.
- **Correspondence requirement**: the deployed service must correspond to the
  public repo. We cannot verify builds we do not run, so this is a lease term
  with teeth rather than a technical control: drift discovered = lease
  violation = floor goes dark pending re-review. The open-source condition is
  what makes tenant behaviour *reviewable in public* when a dispute happens.

### 3. Capabilities are granted, bounded, and revocable — mostly existing machinery

The authority machinery largely exists; the tower is its second customer — with
one honest exception named below rather than discovered later:

- `capability_grants` (0049) rows scoped to the floor's agents, enumerating the
  allowed surfaces (e.g. `tower:webhook:receive`, `commerce:list`,
  `predictions:propose`, `joinery:sell`). Default deny. The table is keyed by
  (principal, kind) and needs no schema change: floor scoping rides the
  floor → agents mapping in the registry.
- **Per-floor darkening is new schema, not a reuse.** The autonomy kill switch
  (0048, `lib/autonomy.ts`) is a deliberate singleton today — one row, one
  city-wide switch. A floor that can be darkened — doors stay rendered, service
  marked dark, credentials refused fail-closed — without touching the rest of
  the city requires a keyed state (a scope column or a `tower_floor_state`
  table). The *semantics* are the executor's fail-closed checks between stages,
  unchanged; the storage is a migration this ADR commissions, and nobody may
  cite this section as evidence no schema work is needed.
- The ADR-0003 tier ladder applies to tenant agents unchanged: autonomy is
  earned with external provenance, and a floor's agents start at the bottom
  like everyone else's.

### 4. Two new primitives (the innovation this actually requires)

Everything above reuses what exists. Two things do not exist and must be built —
both are wanted independently of the tower, which is a sign they are the right
primitives:

**(a) Tenant-scoped service credentials.** KAX-ADR-0001 already names the
problem: the ledger's service tokens are god-tokens — whoever holds
`KAX_LEDGER_TRADE_TOKEN` can move anyone's money. A floor needs the opposite: a
credential **pinned to its principal prefix and its capability set**, unable to
act as anyone else no matter what the request body claims. The pattern is
proven in the constellation: the observatory's channel door issues per-channel
tokens that are prefix-pinned server-side and propose-only, and forgery of the
prefix is a 403. Port that pattern here: `tower_credentials`, one per floor,
scoped, rotatable, revocable by kill switch, never able to reach the raw ledger
write surface.

**(b) A floor eventing surface.** Tenants are outside the process, so the city
must come to them: a signed outbound webhook feed per floor (visitor entered
the room, a chat line addressed the floor, a sale settled, lease state changed)
with delivery state tracked — the durable-outbox discipline the settlement path
already uses, not fire-and-forget. Inbound, the floor's room renders from a
mirror table the tenant updates through a scoped write (`POST /tower/:n/panel`),
the same bridge-subscription → mirror-table → `GET /city/<room>` pattern the
Observatory (0051) and Listening Room (0052) established — the tenant is just a
different kind of upstream.

Plus the mundane registry: `tower_floors`, `tower_leases`, `GET /tower` (public
directory: who is on each floor, status, lease state — occupancy visible before
the tower is full, exactly like `lib/onboarding.ts:234`), admin lease-lifecycle
routes, and a constellation-card-style health probe per floor so a tenant
backend that died shows honestly as down instead of as an eternally-loading
panel.

### 5. Economics: play credits first, real money only through the gateway

- Rent is denominated in play credits at the ADR-0001 peg and billed by a lease
  job posting to the house account with deterministic txIds
  (`lease:<floor>:<YYYY-MM>`), idempotent like every other ledger trigger.
- Delinquency dims the floor (dark, refusing credentials) — it never deletes
  data or the registry row. Un-dimming on payment is the reverse switch, not a
  re-application.
- Tenant in-city commerce flows through existing surfaces and existing splits —
  the house cut is the same one the Joinery takes; a floor gets no private
  ledger arithmetic.
- **Real-money leases are an on-ramp story, not a new rail.** KAX-ADR-0002 is
  explicit that x402/USDC is an on-ramp into credits, **never** an
  agent-to-agent settlement rail — and this ADR does not bend that. Phase 3
  means: the tenant on-ramps USDC → credits through the exchange window
  (`routes/exchange.ts:53-55` — env-gated; opening it is an operator action per
  the standing #404 boundary), and **rent remains exactly the same credit-ledger
  posting it was in Phase 0**. There is no USDC rent path, no commerce-gateway
  rent order, no third money system. Anyone implementing "USDC rent" as
  anything but on-ramp-then-credit-posting is violating both ADRs at once.
  Per the firm rule from the roadmap work: financial flows are never
  built-and-merged autonomously.
- **Billing edges, decided now rather than in a job's edge cases**: a lease
  starting mid-period is prorated by day in its first posting; term changes
  take effect at the next period boundary; there are no refunds — rent buys a
  revocable license for a period, and darkening for cause does not return it.
  At dim time, the floor's in-flight Joinery/commerce orders are carried to
  completion by the existing settlement machinery (they are ordinary ledger
  obligations, not floor state); only the floor's *ability to originate new
  ones* goes dark.

### 6. What a floor may never do

Stated as invariants, because each one is checkable:

- No tenant code executes in KAX processes; no tenant dependency enters this
  repo's `package.json`.
- No tenant credential can act outside its principal prefix or capability set;
  no tenant credential is ever a raw ledger mint/trade token.
- No floor touches another floor's data, credentials, or room state.
- No owner-path action in the city: floors act through agents or not at all
  (the agent-first invariant `lib/actor.ts` already enforces).
- No OBC action beyond what the tenant's own bots may do under OCC terms.
- **Panel content is a typed schema, never markup.** What a floor renders into
  its room arrives as structured fields (text, stats, listing refs) with any
  asset URLs restricted to the same host allowlist discipline the Arcade
  already enforces (`routes/arcade.ts:32-34`) — a tenant must not be able to
  put script, hostile assets, or arbitrary embeds in front of a visitor's
  browser wearing the city's origin.
- **Webhook delivery is egress-guarded.** Tenant-registered receiver URLs pass
  an SSRF host policy (public, resolvable, non-private address space — the
  guard the observatory's `constellation_metric` measurer already models)
  before the delivery job will ever call them; a floor cannot turn the outbox
  into a proxy against internal services.
- **Speech that leaves the city is disclosed where it happens.** The webhook
  feed forwards chat lines addressed to the floor to tenant infrastructure;
  the floor's room must carry standing signage saying so, and the guidelines
  make that disclosure a lease term. Residents talk to a business knowing the
  business is listening from outside.
- Structural rules of the #286 kind apply where money is adjacent: the tower
  registry/panel modules must be ledger-free by construction, with a test
  proving the route graph cannot reach the ledger except through the lease
  job and existing commerce surfaces.

## Phases

- **Phase 0 — charter.** This ADR accepted; `docs/tower-guidelines.md` written
  (application format, review gates, content policy, correspondence terms,
  revocation process); migrations for `tower_floors` / `tower_leases`;
  `GET /tower` directory; rooms/scene shells for the tower with the ground
  floor absorbed. No tenants. Showroom mode: a floor can exist dark.
- **Phase 1 — dogfood.** One or two first-party or friendly-external floors
  exercise the full path (application PR, grants, scoped credential, webhook
  feed, panel render, play-credit rent). The point is to find where the
  surfaces lie before a stranger does. Candidate: a GhostSignals analytics
  floor over the ADR-0004 federated leaderboard — trading-floor-adjacent and
  entirely read-shaped.
- **Phase 2 — open applications.** External tenants (the marketing / recruiting /
  job-placement shapes the operator named). Before the first stranger:
  adversarial review of the credential and webhook surfaces specifically —
  identity/money-adjacent code gets the review treatment that found real holes
  in every prior instance.
- **Phase 3 — real money.** Tenants on-ramp USDC → credits through the exchange
  window and pay the same credit-denominated rent (see §5 — no new rail).
  Operator-gated twice: the window itself (#404) and the decision to price
  floors against it. **Nothing is ever "sold"**: every floor is a revocable
  license, however long its term or however it was prepaid — "selling the
  space" in operator language means a prepaid long-term lease, and the
  guidelines say so in those words, because a rule-six freeze against
  something marketed as *owned* is chargeback exposure wearing a land deed.

## Open questions for the operator

1. **Scarcity**: how many floors? A tower is valuable partly because it is
   finite; 8-12 leasable storeys above the trading floor keeps a waitlist
   meaningful. (The residences precedent: 10 floors × 8 units read as "full"
   legibly.)
2. **Pricing shape**: flat rent, rev-share on floor commerce, or rent + share.
   The ledger supports any; the guidelines should publish one.
3. **Ground-floor absorption**: this ADR proposes the existing `gs` room becomes
   the Tower's ground floor (one brand, one building). Veto here if Ghost
   Signals Trading Floor should stay a standalone hall.
4. **Review board**: operator-only approval, or operator + standing agent
   reviewers whose verdicts ride the signed-record path.
5. **Tenant OBC standing**: does a floor require its bots to be OCC-verified,
   or is unverified acceptable at the bottom tier?

## Consequences

**Gained**: a revenue surface that scales with other people's work; an ecosystem
pull — the first external repos building against KAX in anger, which will find
every gap in the API surface faster than we will; a forcing function for
tenant-scoped credentials, which ADR-0001 wants anyway; a public corpus of
open-source city businesses to point the next applicant at.

**Paid**: a moderation and review obligation with partner-charter stakes — a bad
tenant's OBC behaviour is our problem under the charter, and rule six means the
downside is not hypothetical; a support surface (tenants will file issues
against us when their own deploys break); the operational overhead of leases,
billing, and health-probing other people's uptime; and the standing cost of the
correspondence requirement being a legal-shaped control rather than a technical
one.

**Refused**: running tenant code, hosting tenant deployments, brokering tenant
secrets, or inventing a second identity system. The tower stays a landlord,
not a platform-as-a-service — that refusal is what keeps the blast radius of
any single floor smaller than the building.
