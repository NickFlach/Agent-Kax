# KAX-ADR-0001 — Agent Economic Authority: bounded, auditable delegation of economic actions

- Status: Proposed (2026-08-15)
- Date: 2026-08-15
- Depends on: KAX session auth (`middlewares/authMiddleware.ts`, `middlewares/requireAuth.ts`), KAX identity tokens (`lib/identity.ts`), OBC bot attachment (`user_bots`, migrations 0002/0022/0023), the double-entry credit ledger (`lib/ledger-core.ts`, `lib/ledger.ts`, migrations 0013/0014), and the one principal derivation in `lib/actor.ts`
- Related: NickFlach/Agent-Kax issue #181 (operator decisions locked 2026-08-13); kannaka-memory `ADR-0041` (Resonance Futures — identity, settlement authority, credit ledger); KAX-ADR-0002 (Commerce Gateway), which depends on this ADR
- Code of record today: `artifacts/api-server/src/lib/ledger-core.ts` (+ `lib/ledger-core.test.ts`), `lib/ledger.ts`, `lib/actor.ts`, `lib/revocation.ts`, `lib/identity.ts`, `lib/joinery.ts`, `lib/joinery-core.ts`, `lib/visibility.ts`, `routes/ledger.ts`, `routes/identity.ts`, `routes/joinery.ts`, `routes/mcp.ts`, `routes/predictions.ts`, `routes/floor.ts`, `routes/agent-storefront.ts`, `middlewares/requireAuth.ts`, `index.ts`. **Every file:line citation below was re-derived against the working tree on 2026-08-15 and must be re-derived again before this ADR is accepted** — the foundation slice moved four of these files while the ADR sat unrevised, and the work this ADR triggers will move them again.

## Context

KAX is moving from a curation and play-credit environment into one where agents take
economic actions with consequences outside the city: a listing that goes public, a
physical product that gets printed and shipped, a purchase funded by USDC that arrived
over x402. The question this ADR answers is the one that has no answer in the codebase
today:

> What economic actions may an agent perform on behalf of its human or organisational
> principal, and what proves afterwards that it was allowed to?

The honest starting position is that KAX has excellent *identity* and almost no
*authority*. `lib/actor.ts` collapses seven historical spellings of "who is acting" into
one canonical principal string. `lib/identity.ts` issues short-lived EdDSA tokens with a
pinned algorithm and a bounded refresh lineage. The ledger is double-entry,
hash-chained, append-only at the trigger level, and idempotent on `txId`. All of that is
about *who* and *what happened*. Nothing in the repo answers *may they*.

The gap is not theoretical. The ledger's write surface is armed in production right now:
an unauthenticated `POST /api/ledger/grant` and `POST /api/ledger/trade` both return 401
rather than 503, which means `KAX_LEDGER_MINT_TOKEN` and `KAX_LEDGER_TRADE_TOKEN` are
set. Those endpoints take the subject whose money moves as a free request **string**,
validated only by `PRINCIPAL_RE` (`routes/ledger.ts:32`). Whoever holds the trade token
can debit any trader account up to its balance; whoever holds the mint token can mint to
any principal, bounded only by an optional *global* daily cap. Under the peg fixed below,
that is dollar-denominated authority with no per-account bound and no subject to
authorise.

This ADR defines the authority primitive. KAX-ADR-0002 (Commerce Gateway) consumes it.
Deliberately, and stated up front because it reverses the obvious sequencing: **Commerce
Gateway v0.1 does not require the full policy engine.** See "Implementation scope".

## Units: one peg, stated once, at all three scales

**1 USDC = 100 play_credit = 100,000,000 ledger minor units — i.e.
`MINOR_UNITS_PER_CREDIT = 1_000_000` and `CREDITS_PER_USDC = 100`.**

Operator decision 3 sets the peg once and never changes it. **This is now code of record,
not a proposal.** `lib/ledger-core.ts:29-34` — the pure, DB-free module that already held
`GENESIS_HASH`, `HOUSE_ACCOUNT` and `MAX_POSTINGS_PER_TX` — exports
`MINOR_UNITS_PER_CREDIT = 1_000_000n` and `CREDITS_PER_USDC = 100n`, with
`MINOR_UNITS_PER_USDC` **derived** from the other two rather than written down a second
time, plus `creditsToMinor()` and a bigint-only `minorToCreditsString()` that renders an
exact decimal instead of dividing in floating point. `lib/ledger-core.test.ts` ("the peg,
pinned") asserts all three scales against each other and against their literal values, so
a silent restatement of the scale fails the suite.

The two places that previously carried the 1e6 factor as an unnamed literal now import
it: `routes/identity.ts:29` is `const SIGNUP_GRANT_MINOR = creditsToMinor(100n)`, and the
display divisor at `routes/ledger.ts:324` is `Number(bal) / Number(MINOR_UNITS_PER_CREDIT)`
alongside an exact `creditsExact` string field. Nothing else in the codebase may restate
the scale as its own literal.

What that landed slice did **not** fix, and what therefore remains outstanding, is the
Joinery unit-label defect below.

Every limit in this ADR is denominated in **integer minor units of a named asset**. There
are no bare `per_transaction: 500` figures and no `minimum_price_usd` mixed into the same
object as a credit amount. A limit that does not name its asset and its scale is not a
limit.

### The live hazard this rule exists to prevent — still unfixed

`splitSale()` in `lib/joinery-core.ts:55` takes the price as a bigint of **minor units**,
and `lib/joinery.ts:486` posts `-split.price` straight to the ledger. Meanwhile
`lib/joinery.ts:174` tells the caller the price must be "a positive whole number of
**credits**", `lib/joinery.ts:177` refuses anything over "`${MAX_LIST_PRICE}` credits",
and `routes/mcp.ts:293` documents the field as "whole **credits**, up to
`${MAX_LIST_PRICE}`".

A piece listed at `1000` therefore debits 0.001 credits. `MAX_LIST_PRICE = 1_000_000`
presented to agents as "1,000,000 credits" is in fact 1 credit. Conservation holds — the
split sums exactly, the chain verifies, nothing is lost — but every human- and
agent-facing string about Joinery money is wrong by a factor of 10^6.

Two consequences the fix must carry, because they are not obvious:

1. `joinery-core.ts:89-98` reasons *correctly* in minor units (a signup grant is
   100,000,000 minor units, so `MAX_LIST_PRICE` is "a hundredth of what a new arrival is
   handed"). The repair is to change the **labels**, not the number — or, if the number
   is re-expressed in credits, to preserve the ratio explicitly as
   `SIGNUP_GRANT_MINOR / 100`.
2. Naively "fixing" the labels by reinterpreting `MAX_LIST_PRICE` as credits raises the
   per-listing ceiling from 1 credit to 1,000,000 credits — **$10,000 at the peg**. The
   unit defect is currently the only thing capping collusive value movement through
   Joinery (see "Platform invariants"). Fix the label and the cap must be re-derived in
   the same change.

Commerce Gateway must not copy this phrasing. KAX-ADR-0002 states the rule for USD:
integer cents, in a column named for its unit (`gross_cents`), never a float, never a
bare `amount`; credits and USD cents are never implicitly converted.

## Platform invariants are not policy

Three of the operator's locked decisions are not defaults, not scope lines, and not
capabilities that happen to be denied. They are permanent properties of the platform:

> **`play_credit` is non-redeemable. No endpoint, MCP tool, background job, policy
> version or approval level may convert `play_credit` to USDC, fiat, or any external
> instrument, or move credits between two users absent a delivered good. This is a legal
> posture, not a feature gap.**

Because of that, the capability enumeration below **does not contain**
`credits.transfer`, `usdc.withdraw`, `fiat.withdraw`, `merchant.payout.change` or
`merchant.bank.change`. Listing a capability as deny-by-default implies an operator may
grant it; these are not grantable at any policy version. They are absent, not denied.

Until the foundation slice landed, these invariants held only by absence of code:
`validatePostings` checked posting count, bigint-ness, non-empty account/kind and
`sum === 0n`, and would have accepted a `trader:X -> house` redemption without complaint.

**Enforcement becomes structural, at the ledger core.** This is written on branch
`fix/ledger-units-topology-revocation` (PR #270, CI green, **not yet merged**) — it is not
on `main`, and until it merges the invariants below still hold only by absence of code.
`validatePostings` (`lib/ledger-core.ts:305`) calls `assertPermittedTopology` (`:204`,
module-private), which evaluates a per-kind permitted account-class topology over the
whole posting array (not per posting — a Joinery sale legitimately mixes `joinery`,
`joinery_fee` and `joinery_royalty` in one transaction). `accountClass` (`:143`) is the
grammar: `house`, `trader:*`, `amm:*`, and `unknown` for everything else. The table
(`PERMITTED_TOPOLOGY`, `:178`):

| kind | may debit | may credit |
| --- | --- | --- |
| `grant` | `house` | `trader:*` |
| `escrow` | `house` | `amm:*` |
| `trade` | `trader:*`, `amm:*` | `trader:*`, `amm:*` |
| `payout` | `amm:*` | `trader:*`, `house` |
| `joinery` | `trader:*` | `trader:*` |
| `joinery_fee` | — | `house` |
| `joinery_royalty` | — | `trader:*` |

A kind absent from the table is refused outright, and so is an account that parses to
class `unknown` — a typo'd account would otherwise become a permanent balance no principal
can spend from.

On top of the table sit three whole-transaction rules, because the shape of a cash-out is
a property of the transaction and not of any single posting:

1. **No bare redemption.** A transaction that debits a trader and credits the house
   without crediting any trader throws. The test is whether house is *credited*, not
   whether house is *present*: `lib/joinery.ts` drops zero-amount postings, so a piece
   cheap enough for the fee to round to zero is a legitimate trader-to-trader sale with no
   house leg at all, and keying on presence would refuse it.
2. **The house's take is bounded as a rate.** Rule 1 alone is defeated by a token
   kickback — `[trader:x −100, trader:x +1, house +99]` credits a trader and still moves
   99 to the house. No threshold on the kickback closes that, because the attacker picks
   the number. What distinguishes a fee from a cash-out is its *rate*, so the house credit
   is bounded against the total debited from traders. Keyed on a trader being debited,
   since the residual sweep at the end of a market credits the house out of a pool and is
   not a fee at all.
3. **A `trade` must cross a trader and a pool.** The per-side table cannot express "one
   leg must be an `amm`", so two traders could otherwise move a balance between them under
   a market's name. The debited and credited classes are required to differ, which given
   the table means one of them is the pool.

`lib/ledger-core.test.ts` ("what it refuses") fails if any of those shapes is ever
accepted, and its redemption case is chosen so that only rule 1 can refuse it — a
100%-fee "sale" where every kind is permitted and every class sits on an allowed side.
This lives in the pure core rather than in a route because the routes are not the only
writers (see "Enforcement boundary").

### The goods-purchase carve-out, and where its boundary actually is

Decision 5 says there are no credit transfers between users. Shipped code already
violates its literal reading: `lib/joinery.ts:485-505` posts buyer `trader:*` →
seller `trader:*`, plus a maker royalty to a *third* `trader:*`. Restating decision 5 as
though it held would make this ADR false on the day it is written.

So name the carve-out instead. **Goods purchase with a platform fee** is a defined
exception to decision 5. Its boundary test has three clauses, and only the first is
enforceable at the ledger core — and, as the first known hole below shows, only partly:

1. **The movement happens under a named sale `kind`, and paying the house is never the
   whole transaction.** There is no generic `transfer` kind and there cannot be one: a
   kind absent from `PERMITTED_TOPOLOGY` is refused outright, so the only trader→trader
   shape the core will accept is `joinery`. The shipped redemption test keys on the house
   being **credited without any trader being credited**, not on a fee posting being
   present — see the first known hole below for why, and for what that costs.
2. **The counterparty is not caller-chosen as a free field.** The seller and maker
   accounts are derived server-side from a listing row (`lib/joinery.ts:384-479`), never
   read out of the request body. Contrast `routes/ledger.ts`, where `principal` *is* a
   request string.
3. **A good is delivered.** The ledger core cannot see this; it is enforced above, by the
   caller writing the delivery row in the same logical operation (`unit_furnishings` for
   Joinery, the order record for Commerce). This clause is an obligation on the caller,
   and this ADR says so rather than pretending the core checks it.

A `trader:* -> trader:*` movement under any kind other than `joinery` is refused at the
ledger core, not at a route.

**Two known holes in the carve-out, stated rather than papered over:**

- With `HOUSE_BPS = 1000` (10%) and integer division, a sale priced below 10 minor units
  computes a house cut of zero, and `lib/joinery.ts:508` filters zero postings out. Such a
  sale posts `trader -> trader` under kind `joinery` with **no fee posting at all**, and
  the shipped topology check accepts it — deliberately, because keying the redemption test
  on the *presence* of a house leg would refuse a legitimate cheap sale. The consequence is
  that the fee clause is an obligation on the caller, not a core check: at the bottom of
  the price range Joinery is a bare P2P transfer wearing a sale's `kind`. The fix is a
  minimum sale price such that the computed fee is ≥ 1 minor unit, enforced in
  `lib/joinery.ts`; until it exists, clause 1 is defeated there.
- Clause 2 stops a caller *naming* a counterparty; it does not stop two cooperating
  agents from arranging one, by listing a piece and buying it. That residual is
  acceptable at play-credit scale and is a named blocker before any real-money asset
  exists on the ledger. It is a collusion-detection problem, not an authority problem,
  and this ADR does not solve it.

## Decision

KAX introduces **Agent Economic Authority**: an explicit, versioned, server-side record
of what a given agent may do on behalf of a given principal, evaluated before every
consequential economic action and recorded immutably afterwards.

Authority is scoped, amount-aware, asset-aware, channel-aware, time-bounded, revocable
and auditable. An agent receives no implicit economic permission from owning a KAX
storefront, from being attached to a verified account, or from holding a valid identity
token.

### Core principle: identity in the token, authority in the database

> Identity establishes who the agent is. Authority establishes what it may do. They live
> in different places on purpose.

**Authority is looked up server-side at evaluation time. The identity token carries
identity only and is never a bearer of economic permission.** This is the fork the
original draft left open, and it is decided here, because it is what makes revocation
effective at the action rather than at token expiry.

The consequence is a cleanup item, not a foundation. The `scopes` claim exists on every
token KAX issues — `routes/identity.ts:189`, `:201`, `:319`, `routes/predictions.ts:141`,
carried through refresh at `routes/identity.ts:407` — and **is never read by any code
path**. A grep returns issuance sites and the refresh carry-through, and nothing else;
the `Actor` struct in `lib/actor.ts` does not even carry it forward. It is decoration.

KAX cannot prove what the remote verifiers (observatory, radio) do with a claim they can
see, because they verify locally against the published JWKS and KAX has no introspection
channel to ask. That asymmetry is the argument for freezing rather than silently
deleting: **`scopes` is frozen as documented NON-AUTHORITATIVE**. No new values are
minted into it, nothing reads it, and remote verifiers must be told in writing that it is
not permission. Removal happens at the next deliberate token-format change, with the
verifiers notified — not as a side effect of this work.

## Actors

**Principal** — the person or legal entity granting authority. The policy key is the
principal string produced by `principalForClaims` / `principalForAgent` /
`principalForUser` in `lib/actor.ts` and derived nowhere else.

**Agent** — the delegate. Canonically the OBC bot UUID, projected into
`kax:agent:<bot_id>`.

**Merchant** — the legal seller in external commerce. See the verified-identity record
below; a merchant is a property of a *user*, never of an agent.

**System** — KAX executing an authorised action through an adapter. The external platform
sees KAX's integration; the audit trail records the agent as the initiating actor and the
service as `on_behalf_of`.

### The verified-identity record (stated identically in KAX-ADR-0002)

One record, two attestation levels:

1. The record is keyed on the **user id** (`lib/db/src/schema/auth.ts` `usersTable`) — the
   human or legal entity — never on an agent principal and never on a ledger account
   string. An agent cannot be a legal person or hold a bank account, and harvested agents
   are owned by `KANNAKA_SYSTEM_USER_ID` (`lib/backfill.ts:256`), i.e. by nobody.
2. Two levels hang off it: `buyer_cip` (satisfies decision 2's bank-account gate) and
   `payee_kyb` (satisfies payout).
3. Directional rule: **`payee_kyb` satisfies `buyer_cip`** — never re-ask a merchant who
   already cleared Connect onboarding. `buyer_cip` does **not** satisfy `payee_kyb`.
4. **KAX does not perform KYC; it records who did.** Store the provider verdict
   (`{provider: 'stripe_connect', account_id, charges_enabled, payouts_enabled,
   requirements_currently_due}`), never the documents.
5. Status fields are **varchar with app-level validation, never a `pgEnum`**.
   `routes/identity.ts:220-221` states the reason outright: "adding pg enum values breaks
   the Replit deploy flow". `user_bots.attached_via` (migration 0022) is the pattern to
   copy.

Decision 2 gates KYC at *bank account creation*, and the bank account is an object that
does not exist in this repo. KAX-ADR-0002 must introduce the account entity itself, not
merely a verification field on something.

## Capability model

Three labelled groups. The distinction matters because two of them are not policy bits at
all.

### 1. Delegation — what an agent may do with authority the principal already has

```
commerce.product.create
commerce.product.update
commerce.product.discontinue
commerce.listing.create_draft
commerce.listing.publish
commerce.listing.unpublish
commerce.price.change
commerce.inventory.update
commerce.order.view
commerce.order.cancel
commerce.reprint.approve
credits.spend
```

These are grantable, scopeable and limitable. New ones may be added without changing the
model.

### 2. Rights preconditions — computed, never granted

`artifact.commercialize` in the original draft reads as a property of the *artifact* but
was listed as a per-agent grant. It is renamed **`commerce.propose_from_artifact`**, and
that name refers only to the delegation ("this agent may propose commerce from artifacts
it is entitled to"). Whether *the artifact* may be commercialised is the output of the
Commerce Gateway's rights preflight, not a policy bit. Granting the delegation can never
substitute for a rights PASS.

This is not a hypothetical distinction: the repo has no rights, licence or
`commercial_use` column anywhere. Without the split, a policy edit would stand in for a
rights determination nobody has ever made.

### 3. Structurally absent

See "Platform invariants are not policy". `credits.transfer`, `usdc.withdraw`,
`fiat.withdraw`, `merchant.payout.change`, `merchant.bank.change` do not appear in the
enumeration and are not grantable.

### `commerce.refund.issue` — deferred with a named reason

The original draft placed refunds in Phase 2. `credit_ledger` and `credit_ledger_txids`
both reject UPDATE and DELETE at the trigger level (migrations 0013, 0014), and **nothing
in the repo emits a compensating posting**. A refund therefore is not a permission
question at all until someone designs a forward-only correction: a reserved compensating
`kind`, its own topology rule, and a link back to the transaction it reverses. Until that
design exists, `commerce.refund.issue` names an action no code path can perform and is
out of scope. Refunds on real money in v0.2 are handled by the connected account as
merchant of record (KAX-ADR-0002), not by the credit ledger.

## Risk classes

**Class 0 — read only.** View balances, orders, inventory, sales.

**Class 1 — reversible operational actions.** Product proposals, listing drafts, mockups,
price recommendations, disabling a product. May be delegated broadly.

**Class 2 — public commercial actions.** Publish, change a live price, discontinue,
customer communication. Explicit permission required.

**Class 3 — value movement.** Spend credits, purchase, stake, initiate a fulfilment
expense. Explicit permission plus limits.

**Class 4 — external financial authority.** Anything touching USDC, fiat, or a payout
destination. Either structurally absent (see invariants) or, where it exists at all,
requires the verified-identity record and human approval — never ordinary policy.

### Class 0 is not currently safe to describe as delegable

Two corrections the draft's "generally safe" gloss would have papered over:

- `GET /api/floor/ledger` and `GET /api/floor/info` (`routes/floor.ts:36`, `:52`) are
  **fully public**. Buyer and seller bot ids, names, credit amounts and OBC escrow ids are
  world-readable to anyone with the URL. "View sales" is not a delegable capability while
  it is also an anonymous one; that exposure needs a deliberate decision (operator) before
  Class 0 means anything.
- There is no per-account audit surface at all. The read surface today is a SUM
  (`GET /api/ledger/my`, `GET /api/ledger/balance`), a single-tx lookup, and a whole-chain
  verify. **An account holder cannot see where their money went.** Phase 1 must add a
  per-principal **statement** endpoint listing that account's postings, seamed into
  `routes/ledger.ts` beside the existing reads. A decision log that records who authorised
  a movement is useless without a surface that shows the movements — and Commerce Gateway
  assumes support and dispute handling that has nothing to read.
- The statement endpoint is itself Class 0, scoped to the caller's own principal.
  Admin/support access to *another* principal's statement is a separate, logged
  capability — not a side effect of holding `KAX_SERVICE_TOKEN`.

## Limits

Every limit is an integer count of **minor units of a named asset**, or a count of
actions, or a percentage of a named base. Never a bare number.

```json
{
  "credits.spend": {
    "asset": "play_credit",
    "per_transaction_minor": "500000000",
    "daily_minor": "2000000000",
    "monthly_minor": "10000000000"
  },
  "commerce.price.change": {
    "max_delta_percent_of_current_price": 5,
    "floor_price_cents": 1200
  }
}
```

`per_transaction_minor: "500000000"` is 500 credits, which is 5 USDC at the peg. Stating
it in minor units of a named asset is the only spelling that cannot be off by 10^6. The
percentage key names its base in the key itself for the same reason: "5%" of the current
price, the floor price and the original list price are three different numbers, and a
limit that does not say which one it means is not a limit either. Where a percentage sits
beside its base as data rather than in the key — as KAX-ADR-0002's commerce leg set does
with `rate_bps` — an explicit `basis` sibling carries the same information.

Limits are evaluated atomically against current usage. Two implementation constraints,
both learned from what exists:

- **The usage accumulator must have an ACCOUNT dimension.** `houseOutflow(kind, asset,
  since)` (`lib/ledger.ts:172`) does not — its `WHERE` filters on
  `account = HOUSE_ACCOUNT` and aggregates globally. It is explicitly **not** the pattern
  to extend: its own comment concedes "Best-effort (a small race window across concurrent
  grants is acceptable for play credits)", which stops being acceptable the moment the
  units are dollars.
- **Reservation rows take a row-level lock on the usage row, never the ledger's global
  advisory lock,** so cap accounting does not serialise behind every unrelated append.

### Platform purchase caps are a different control

Operator decision 6 sets a ~$100/day per-account purchase cap on the USDC → credits
on-ramp. That is a **platform** control, specified in KAX-ADR-0002: evaluated per
**verified identity** (not per principal — principals are cheap, one per attached bot,
and `/auth/token/exchange` auto-provisions users with no session), denominated in USD,
with both a rolling-24h and a calendar-month window.

Platform purchase caps and per-agent `credits.spend` limits **compose**; neither
substitutes for the other. One bounds how much value enters an identity; the other bounds
how much of it a delegate may move.

The signup grant in `routes/identity.ts:31-45` must be brought under the same accounting
or explicitly exempted with a named reason recorded in code, because today it is the one
mint that no cap sees at all — it calls `postTransaction` directly, bypassing both
`requireLedgerMintToken` and `KAX_LEDGER_GRANT_DAILY_CAP`.

## Scope dimensions

**Resource scope** — authority restrictable to specific collections, products or
storefronts.

**Channel scope** — `{ "kax": true, "printify": true, "etsy": false }`. Auto-publish
internally, drafts only externally.

**Asset scope** — permissions never propagate between assets. `credits.spend = true` on
`play_credit` implies nothing about any other asset, and there is no asset on the ledger
today other than `play_credit` (`ALLOWED_ASSETS`, `routes/ledger.ts:38`).

**Time scope** — `expires_at` on any grant. Temporary delegation is preferred for
experimental high-risk capabilities. An expired grant denies with reason
`grant_expired`.

## Policy storage

Two tables. Neither is ever UPDATEd in place.

**`authority_policies`** — immutable, one row per version:
`principal`, `agent_principal`, `version` (integer), `document` (jsonb),
`document_hash` (sha256 of the canonical document), `effective_from`, `superseded_at`,
`created_by`. A policy edit INSERTs a new row and stamps `superseded_at` on the prior
one.

**`authority_decisions`** — append-only:
`decision_id`, `agent_principal`, `principal`, `capability` (varchar), `resource`,
`channel`, `asset`, `amount_minor`, `decision`, `reason_code`, `policy_id` (FK to the
exact immutable policy row), `policy_document_hash`, `tx_id`, `postings_hash`,
`expires_at`, `correlation_id`, `approval_source`, `on_behalf_of`, `created_at`.

The decision references the policy **row id plus its document hash**. `policy_version = 7`
— the entire storage design in the original draft — cannot prove which document
authorised a historical action, only which integer was current at some point.

Apply the append-only trigger pattern from migrations 0012/0013/0014 verbatim to
`authority_decisions`. `capability` and `decision` are **varchar with app-level
validation, never a `pgEnum`** (same Replit deploy reason as above).

### Principal keys, and the form-mismatch trap

Policy lookup is keyed on the principal string from `lib/actor.ts` and derived nowhere
else. The `obc:bot:7c1...` key in the original draft's example **exists nowhere in this
codebase** and would fail every lookup.

Normative rules:

- Collapse the `obc:<uuid>` channel-link form to `kax:agent:<uuid>` before lookup. Reuse
  `botIdOfPrincipal` (`lib/revocation.ts:86`), which already accepts both prefixes.
- An agent with no OBC bot id gets `kax:kaxagent:<id>` (`principalForAgent`,
  `lib/actor.ts:56-61`) and **must be able to hold its own policy row** rather than
  silently sharing one.
- A principal string that does not parse into a known form is a DENY with reason code
  `principal_unparseable` — distinct from `policy_missing`, so a form mismatch is never
  mistaken for a legitimate denial.

### Schema registration, in all three places

Both tables need an idempotent `CREATE TABLE IF NOT EXISTS` entry in
`lib/ensureCriticalSchema.ts` **on the same publish** as their migration, following the
existing entries there. A table registered in only one of the required places disappears
on the next publish against a schema-diffed database.

State the fail-closed consequence plainly: **if `authority_policies` is unreachable, every
value-moving action denies and the economy halts.** That is the correct behaviour and it
is also an availability event the operator must be told about, so both tables must appear
in `GET /health/schema` (`routes/health.ts:49`).

## Evaluation timing

Three rules. Every economic path in this repo has a gap between request, approval and
execution, and the draft did not say which one governs.

### 1. Admission — authority is evaluated BEFORE the ledger transaction opens

`postTransaction` (`lib/ledger.ts:62`) holds `pg_advisory_xact_lock(LEDGER_ADVISORY_KEY)`
where `LEDGER_ADVISORY_KEY = 0x1ed6e401` (`lib/ledger.ts:20`). That serialises **every**
ledger append in the process into a single FIFO queue. The naive implementation — a
policy lookup, a KYC check, or an HTTP call inside `postTransaction` — extends that lock
for every concurrent writer in the system.

Therefore: no network call, no HTTP approval check, no unindexed query while the lock is
held. Authority is evaluated at admission, above the lib boundary, before the transaction
opens.

### 2. Binding — the decision names the exact transaction it authorises

The decision record carries the **canonical postings hash** of the transaction it
authorises, computed with the same function the idempotency registry already uses:
`canonicalPostingsHash(txId, asset, postings)` (`lib/ledger-core.ts:251`), plus `asset`,
`tx_id`, `decision_id` and an explicit `expires_at`.

The only authority work permitted **inside** the ledger transaction is a single cheap
indexed read: confirm a decision row exists whose `postings_hash` matches and whose
`expires_at` has not passed.

> **Implementation warning, load-bearing.** The actor must NOT enter `computeEntryHash`
> (`lib/ledger-core.ts:98`) or `canonicalPostingsHash` (`:251`). Adding a field to either
> canonicalisation invalidates **every existing chain entry** and **every stored
> `postings_hash`** — `verifyChain` would fail from genesis and every replay would raise
> `LedgerIdempotencyConflict`. The subject belongs on `credit_ledger_txids` (one row per
> transaction), not in the hashed tuple.

### 3. Re-evaluation — queued work re-authorises at execution

Anything queued, awaiting human approval, or awaiting an external provider **must be
re-evaluated against the current effective policy at execution time**, and must write a
**second** decision record. The queued decision is admission evidence, never execution
authority.

Policy tightening between queue and execution **wins**. Policy loosening does **not**
retroactively bless a queued item — it must have been authorised both when it entered the
queue and when it left.

## Enforcement boundary

The draft asserted that "all economic mutations must pass through the same authorization
service". As written that is false in this codebase, and an implementer who believes it
will put the check in the wrong place. Three layers, each with a named home:

```
  inbound                     ADMISSION (lib boundary)        SYSTEM OF RECORD
─────────────────────────────────────────────────────────────────────────────────
  POST /api/joinery/buy ─┐
  routes/joinery.ts      │
                         ├──►  lib/joinery.purchase()  ──►  lib/ledger.postTransaction()
  POST /api/mcp          │      ▲                             │  advisory lock 0x1ed6e401
  tools/call joinery_buy─┘      │                             │  idempotency on txId
  routes/mcp.ts:356             │                             ▼
                                │                        lib/ledger-core
     routes/joinery.ts is NOT   │                        validatePostings()
     in the MCP stack ──────────┘                        = POSTING TOPOLOGY
     an Express middleware here
     sees nothing
```

1. **Posting topology** is enforced in `lib/ledger-core.ts` `validatePostings` — pure,
   DB-free, unit-testable, no lookups. This is where the platform invariants live.
2. **Subject** is enforced by making `actor` a **required** field of `PostTxInput`
   (`lib/ledger.ts:42`, today `{ txId, asset, postings }`), so `postTransaction` will not
   type-check without it. The actor is recorded once per transaction on
   `credit_ledger_txids`, so a row can answer "who caused this".
3. **Policy and limits** are evaluated at admission, before the ledger transaction opens.

**Enforcement lives at the LIB boundary, never in an Express handler or middleware.**
The `joinery_buy` tool (`routes/mcp.ts:334`) calls `lib/joinery.purchase()` directly at
`routes/mcp.ts:356`; `routes/joinery.ts` is never in that stack. A middleware mounted on
the router would be invisible to every MCP tool call. `app.ts` mounts exactly one global
**authentication** middleware (`authMiddleware`, `app.ts:95`); it authenticates a session
and authorises nothing. No global authorisation middleware exists.

**Phase 1 converts all three existing `postTransaction` callers** to pass an actor:
`routes/ledger.ts:99`, `routes/identity.ts:33`, `lib/joinery.ts:510`.

## Inbound path inventory and enforcement coverage

Every path that can mutate economic state, with an explicit verdict. Without this table a
reader cannot tell what is in scope.

| # | Path | File | Auth today | Subject | Verdict |
| --- | --- | --- | --- | --- | --- |
| a | `POST /ledger/grant` `/escrow` `/trade` `/payout` | `routes/ledger.ts:145,184,211,244` | shared bearer secret (`requireLedgerMintToken` / `requireLedgerTradeToken`) | arbitrary request **string** validated by `PRINCIPAL_RE` | **No subject to authorise.** Highest-value write surface in the repo. Needs the m2m decision below. |
| b | `POST /joinery/buy`, `POST /joinery/sell` | `routes/joinery.ts:136,61` | `resolveActor` | real actor | Interceptable, but only usefully at the lib boundary — see (c). |
| c | `POST /mcp` `tools/call` (`joinery_buy`, `joinery_sell`) | `routes/mcp.ts:334,283` | `resolveActor` | real actor | Interceptable **only at the lib boundary**. Calls `lib/joinery` directly (`routes/mcp.ts:356`); `routes/joinery.ts` is bypassed entirely. |
| d | `grantSignupCredits` via `POST /auth/token` **and** `POST /auth/token/exchange` | `routes/identity.ts:31,193,204,322` | `requireAuth` on the first; on the exchange, **federated**: remote introspection of a SpaceChild access token against `auth.spacechild.love/auth/sso/verify` (`routes/identity.ts:235-334`), **no KAX session**, and an unknown email is auto-provisioned as a new user | derived principal | **A 100-credit house mint outside `requireLedgerMintToken` and `KAX_LEDGER_GRANT_DAILY_CAP`, on an identity KAX does not itself vouch for.** Must be brought under accounting or exempted with a recorded reason. |
| e | `POST /predictions/:id/trade` | `routes/predictions.ts:117` | `requireAuth` (session) | KAX user | The mutation **executes at the radio hub**; settlement returns as a *separate* inbound request to `/ledger/trade`, i.e. as row (a) with no subject. |
| f | `POST /api/webhooks/*` | `routes/webhooks.ts`, raw-body carve-out in `app.ts:83-93` | HMAC-SHA256 over raw bytes | **no principal** | Authenticates a sender, identifies no subject. Must not reach `postTransaction`. |
| g | `warmUpInBackground` (11 startup steps, 4 schedulers) and `lib/constellationBridge.ts` NATS subscribers | `index.ts:210-241`, `lib/constellationBridge.ts:270-294` | none | **no principal** | No authority path exists. See binding constraint below. |

**Binding constraint for (g):** background jobs, schedulers and NATS subscribers **MUST
NOT call `postTransaction`**. This is enforced by a test that fails if any module reachable
from `warmUpInBackground` or `constellationBridge` imports the ledger write path. The
alternative — defining a SYSTEM principal with its own policy row — is deliberately
rejected for Phase 1: a system principal that can mint is the same unbounded authority
row (a) already has, wearing a policy. If a background economic action becomes genuinely
necessary, it comes back as an amendment to this ADR, not as an import.

## Machine-to-machine economic callers

**A shared bearer secret authenticates an integration. It never authorises a subject.**

Row (a) is the concrete failure: `KAX_LEDGER_TRADE_TOKEN` lets its holder debit any trader
account up to its balance, and `KAX_LEDGER_MINT_TOKEN` lets its holder mint to any
principal, bounded only by an optional **global** daily cap. At 100 credits = 1 USDC, that
is direct dollar-denominated authority with no per-account bound. Meanwhile the draft's
evaluation model begins with "WHO? Agent identity" — and this surface has no identity to
evaluate.

Two options; **(A) is the decision, (B) is the interim.**

**(A) Delegated service identity — REQUIRED before any real-money asset exists.** The
radio hub presents a KAX-issued `service` identity token alongside the end user's
delegated token. The decision is evaluated against the **end user's** policy, with the
service recorded as `on_behalf_of`. `PrincipalKind` already includes `service`
(`lib/identity.ts:65`, accepted by `verifyToken` at `:253`) — and **nothing anywhere
issues one**, so "the hub acting for trader X" is currently unrepresentable. Phase 1b adds
the issuance site.

**(B) Interim, while the hub still holds a shared secret.** `/ledger/*` gains a mandatory
per-principal authority lookup bounding which principals a given integration may move and
by how much. This is a stopgap: it authorises the *integration*, not the user.

`on_behalf_of` is a required field of `authority_decisions` and of the audit field list
below.

## Human approval

The approval surface is **new work, not a wiring change**. Five approval modes were listed
in the draft (`none`, `human_each_time`, `human_above_threshold`, `human_first_time`,
`human_for_external_channels`) and there is no authenticated path a human can use to
satisfy any of them.

**Auth lane, decided:** approval endpoints are **session-authenticated (cookie)** and
re-read the user row live via `requireAuth` / `getOptionalAuth`. They must **not** be
reached through `resolveActor`, which hard-401s a session-shaped bearer
(`lib/actor.ts:90`) and never falls through to the session door.

**Pending-approval entity:** `id`, `decision_id`, `requested_by` (principal),
`capability`, `resource`, `asset`, `amount_minor`, `expires_at`, `approved_by` (user id),
`approved_at`. An expired approval DENIES with reason `approval_expired` — the draft's
Failure Behavior already listed that outcome while nothing in the system expired.

**The approver must be a distinct human principal from the requesting agent.**
Self-approval by an agent token is refused.

The evidence that no working human economic surface exists is worth stating because it
sets the size of this work: `GET /api/ledger/my` (`routes/ledger.ts:298`) accepts **only**
an identity JWT with no session fallback, and `artifacts/kax/src/pages/bank-hall.tsx:32`
fetches it with **no Authorization header** — so the bank page has never shown a real
balance to a browser visitor, and says so in its own fallback copy at line 41.

## Revocation

Replace "immediately" with the honest contract:

> **Revocation is effective at the next authority evaluation.** Authority is evaluated
> server-side, at action time, from database state — never from a token claim. That is
> what makes this bound tight rather than tied to token expiry.

And then the four gaps, all Phase 1 work items, because revocation today is not merely
latent — it is **bypassable**:

**(a) One enforcement gate.** `isRevoked` (`lib/revocation.ts:33`) is called from exactly
one enforcement gate — `lib/actor.ts:99`, the agent-**token** branch of `resolveActor`. Its
only other call site, `routes/identity.ts:97`, is a read-back inside the admin
`POST /identity/revocation` handler and gates nothing. `agentForActor` (`lib/actor.ts:157`)
therefore lets a signed-in owner act for a revoked agent with no revocation check at all.

**(b) Mint and refresh ignore revocation.** `POST /auth/token`
(`routes/identity.ts:176-184`) and `POST /auth/token/refresh` (`:388-399`) check only that
a bot is **attached**, and `revoke()` (`lib/revocation.ts:56`) sets `revoked_at` without
detaching. A revoked bot's owner can therefore mint fresh 15-minute tokens indefinitely
and refresh a lineage for up to `MAX_TOKEN_LIFETIME_SEC` (30 days). Both lookups need an
`isNull(revokedAt)` predicate.

**(c) The m2m ledger surface runs no revocation check** on the principal it is handed.

**(d) Remote verifiers cannot be told.** `lib/identity.ts:48-50` says it outright: hard
revocation via a `jti` blocklist the verifiers poll is a follow-up, and until then the
short TTL is the containment. So the honest containment window for a token already in a
remote verifier's hands is **`AGENT_TOKEN_TTL_SEC` (15 minutes) plus the hub's settlement
lag**. Closing it requires either a `jti` blocklist the hub polls, or a KAX-side refusal
on inbound `/ledger/trade` for a revoked principal. The second is cheaper and is the
Phase 1 choice; the first is the correct long-term answer.

**Queued work.** Replace "some queued actions may require cancellation" with the rule that
falls out of "Evaluation timing": **every queued economic action re-evaluates authority at
execution, so a revoked principal's queue drains to DENIED without a cancellation sweep.**
Only work already submitted to an *external* provider needs an explicit cancel/reconcile
path — see the reservation protocol below.

`residencyStore.ts:89` `REVOCATION_REFRESH_MS = 60_000` is a presence sweep that evicts
residents. It is not an economic control and must not be mistaken for one.

## Limit reservation across an external boundary

`reserveLimit()` / `commitUsage()` / `releaseReservation()` is coherent for internal
credit movement and silently wrong for a fulfilment order that spends real money at an
external provider. Naive release under-counts a cap and lets an agent exceed it by
retrying; naive retry double-submits a physical order. The protocol, numbered, reusing
what exists:

1. **`reserveLimit` writes a MUTABLE intent row in a NEW table** — states
   `reserved -> submitted -> outcome_unknown -> committed | released` — carrying a
   caller-generated idempotency key, the target provider, the **exact canonical posting
   array** to be used on commit, and the `decision_id`. This table is separate from
   `credit_ledger_txids` precisely **because** that registry is append-only by trigger
   (migration 0014) and can never be amended with a later confirmation.
2. **The intent row is committed BEFORE the external call.** Joinery's money-first
   ordering — "the reverse order would be much worse: a chair in the room with no receipt"
   (`lib/joinery.ts:22-29`) — applies to *internal* postings only and **inverts across an
   external boundary**. Internally: post, then write the row. Externally: write the intent,
   then call, then post.
3. **The external call carries the intent's idempotency key** as the provider's own
   idempotency header.
4. **On timeout / 5xx / network error the state becomes `outcome_unknown`.** Do not
   release, do not re-submit, do not commit. The reservation stays held against the cap,
   because over-counting a cap is recoverable and a double-submitted physical order is
   not.
5. **Resolution is by a provider-side READ keyed on that idempotency key**, or by the
   adapter's `reconcile()`. Only a definitive negative releases.
6. **The terminal COMMIT posts with a `txId` derived deterministically from the intent
   id** — following the existing conventions `grant:signup:<principal>`
   (`routes/identity.ts:34`) and `joinery:<listingId>:<buyerAccount>`
   (`joinery-core.ts:85`) — reproducing the stored posting array **byte-for-byte**.
   `canonicalPostingsHash` is order-, asset- and `ref`-sensitive, so a retry that differs
   in any of those raises `LedgerIdempotencyConflict` (409), which is a hard failure, not
   a replay.
7. **Operator alert on intents ageing in `outcome_unknown`.** They consume cap headroom
   until reconciled, so an unnoticed one silently shrinks an agent's limit.

```
  reserved ──► submitted ──► committed          (provider confirmed, postings applied)
                   │
                   ├───────► released           (definitive negative ONLY)
                   │
                   └───────► outcome_unknown ──► committed  (provider read says yes)
                                   │             released   (provider read says no)
                                   │
                             holds cap headroom; alerts on age
```

## Failure behaviour

Authority failures fail **closed**, using one named idiom.

**The idiom is `requireLedgerMintToken`'s** (`middlewares/requireAuth.ts:120-131`):
explicit refusal with a 503 when unconfigured, never a fallback. It is specifically **not**
`requireAdminOrServiceToken`'s (`:88-95`), which silently falls through to `requireAdmin`
when `KAX_SERVICE_TOKEN` is unset — no error, no log, just a different policy quietly
governing `/identity/revocation` and `/admin/db/migrate`. The codebase already contains
three incompatible fail behaviours (503-and-refuse, silent degradation,
`process.exit(1)`), so an implementer will otherwise copy whichever neighbour they happen
to read.

Every fail-closed denial carries a **machine-distinct reason code**, so an availability
failure is never indistinguishable from a legitimate denial:

```
policy_missing            no policy row for this (principal, agent)
policy_table_unavailable  the policy store could not be read
principal_unparseable     the principal string is not a known form
limit_exceeded            a real, legitimate denial
reservation_unavailable   the intent table could not be written
approval_required         needs a human; not yet a denial
approval_expired          a human approved, too long ago
revoked                   the agent's verification was withdrawn
grant_expired             the delegation's expires_at has passed
rights_precondition_failed the artifact's rights preflight did not PASS
```

**Trigger condition, named so it is not missed:** once any authority decision governs real
value, `verifyLedgerChainAtBoot()` in `index.ts:173` must be revisited. Its own comment
conditions the non-fatal choice on "the ledger isn't yet load-bearing" — and this ADR is
the event that changes that. Whether a failed boot-time chain verification should then be
fatal, or should disarm the write surface while continuing to serve reads, is an open
question for the operator.

## Default policy

A new agent gets:

```
READ (own statement)                     ALLOW
CREATE PRODUCT PROPOSAL                  ALLOW
CREATE DRAFT LISTING                     ALLOW
CHANGE PRICE                             DENY
PUBLISH LISTING                          DENY
SPEND CREDITS                            DENY
ANY EXTERNAL CHANNEL                     DENY

CLASS 4, withdrawal / payout-destination  STRUCTURALLY ABSENT — not a policy default
  credits.transfer, usdc.withdraw,        (no capability name exists; there is no
  fiat.withdraw, merchant.payout.change,   value of this policy that grants them)
  merchant.bank.change
CLASS 4, everything else                  DENY — grantable only with the
                                           verified-identity record AND human approval
```

Only the rows above the blank line are **defaults**: the principal expands each one
deliberately, per capability, with limits. The withdrawal and payout-destination row is not
a default and has no ALLOW side at any policy version — it appears in the block only so a
reader does not read its absence as an omission, and conclude that withdrawal is an
ordinary denied capability an operator could flip. See "Platform invariants are not
policy".

## Audit requirements

Each economic action's record carries: timestamp, agent principal, principal, merchant (if
any), capability, resource, channel, amount in minor units, asset, policy row id, policy
document hash, decision, reason code, approval source, `on_behalf_of`, `tx_id`,
`postings_hash`, correlation id, result.

The trail answers *who caused this economic action*, not merely *which endpoint ran*.

Denials are recorded when materially relevant — every Class 3 and Class 4 denial, and
every denial carrying an availability reason code, so a policy outage is visible in the
same place as a policy refusal.

## Implementation scope

### Phase 1a — what Commerce Gateway v0.1 actually needs

**Commerce Gateway v0.1 does not require the Authority service.** Putting a greenfield
policy engine on the critical path of a one-sticker proof is the largest sequencing error
available here, and the claim `scopes` would build on is decoration.

Phase 1a answers exactly one question — *may this actor commercialise this artifact* —
with **no new subsystem and no policy engine**: `resolveActor(req)` + `isRevoked` +
`commerceEligibleWhere()`, the commerce-eligibility predicate KAX-ADR-0002 defines once in
`lib/visibility.ts` (`creator_bot_id` NOT NULL, present in `user_bots` with
`revoked_at IS NULL`, owned by the requesting principal). Plus one immutable
`authority_decisions` row per consequential action.

`commerceEligibleWhere()` is a **third** predicate and must never be re-derived ad hoc in a
route. It is not `publicArtifactWhere()` (`lib/visibility.ts:72`), which answers
publication, and it is emphatically not `agentWorksWhere(agent)`
(`routes/agent-storefront.ts:333`), which answers *whose storefront does this piece appear
on* by attributing on `agentId` OR `creatorBotId` and deliberately applies no publication
gate at all. **Storefront appearance is not commercial eligibility.** An earlier draft of
this ADR named `agentWorksWhere` as the v0.1 gate; that was wrong twice over — wrong on the
semantics, and wrong on the mechanics, because `agentWorksWhere` is module-private
(`function agentWorksWhere(agent: Agent)`, no `export`) and a `lib/` module cannot call it.

Everything else in v0.1 is DENY, hard-coded, with no policy row at all.

KAX-ADR-0002 carries the matching amendment: "every consequential Commerce Gateway action
records an immutable authority decision; the full policy engine is a v0.2 dependency, not
a v0.1 one."

Two Phase 1a items are written and reviewed but **not yet on `main`**. They live on branch
`fix/ledger-units-topology-revocation` (PR #270 — CI green, 641 tests passing, awaiting
merge), and are recorded here because the rest of the list is sized against them. Until
that PR merges, treat both as outstanding:

- `MINOR_UNITS_PER_CREDIT` / `CREDITS_PER_USDC` / `MINOR_UNITS_PER_USDC` in
  `lib/ledger-core.ts:30-34`, pinned by `lib/ledger-core.test.ts`. **Written, unmerged.**
- Per-kind topology in `validatePostings`, with the redemption-shape tests
  (`lib/ledger-core.ts:178-297`, reached from `:320`). **Written, unmerged.**

Still outstanding in Phase 1a, because they are correctness fixes to shipped code rather
than new architecture:

- **The Joinery unit labels**, still wrong at `lib/joinery.ts:174`, `:177` and
  `routes/mcp.ts:293`, with `MAX_LIST_PRICE` re-derived in the same change so the fix does
  not silently raise the per-listing ceiling by 10^6 (open question 4).
- **A minimum sale price** such that the computed house fee is ≥ 1 minor unit, closing the
  fee-free cheap sale.
- `actor` required on `PostTxInput`; all three callers converted.
- `isNull(revokedAt)` on the mint and refresh bot lookups; `isRevoked` in
  `agentForActor`.
- Both authority tables in migration **and** `ensureCriticalSchema` **and**
  `GET /health/schema`, on the same publish.
- The per-principal statement endpoint.

**Two extractions this phase silently depends on, named so they are not discovered late.**
Both are refactors of module-private code that Phase 1a and Commerce Gateway v0.1 intend to
reuse across a module boundary:

- `agentWorksWhere` moves from `routes/agent-storefront.ts:333` into `lib/visibility.ts`,
  beside `commerceEligibleWhere()`, and is exported. `lib/storefrontArtifactVisibility.test.ts`
  pins its call sites by **source-string** assertions —
  `expect(WORKS).toContain("agentWorksWhere(agent)")` and a body check that slices from
  `"function agentWorksWhere"` — so those assertions must be updated in the same commit or
  the suite fails on a pure move.
- `hostAllowed`, `ALLOWED_HOST_SUFFIXES` and `FRAME_SIZE_CAP` (`routes/arcade.ts:45`, `:32`,
  `:53`) move into a shared `lib/` module before KAX-ADR-0002's byte-measuring print-asset
  fetch can reuse the SSRF pattern they implement. None of the three is exported today.

### Phase 1b — the policy engine (v0.2)

Policy documents and versioning; per-channel scope; amount limits with the account-dimensioned
accumulator; approval modes and the session-authenticated approval surface; the
`service` token issuance site for option (A); the reservation protocol for external
boundaries.

### Phase 2

Resource-scoped policies; approval thresholds; policy templates; agent-to-agent purchase
under the goods carve-out with collusion controls; the forward-only correction design that
`commerce.refund.issue` would need.

### Phase 3

Organisation policies; multi-user principals; delegated sub-agents; approval workflows;
policy inheritance; risk scoring.

## Non-goals

Payment processing, tax handling, POD providers, Etsy, manufacturing, artifact rights
*verification* (as opposed to consuming its verdict), image processing, accounting
implementation. Those belong to KAX-ADR-0002 and downstream systems.

## Open questions — named, with who decides

1. **Public floor ledger.** `GET /api/floor/ledger` and `/floor/info` expose buyer and
   seller identities and amounts anonymously. Keep, restrict, or redact? — **Operator.**
2. **Boot-time chain verification.** Once value is real, is a failed
   `verifyLedgerChainAtBoot` fatal, or does it disarm writes and keep serving reads? —
   **Operator.**
3. **The `scopes` claim.** Frozen as non-authoritative here. Removing it requires
   coordinating with the observatory and radio verifiers, which this repo cannot audit. —
   **Operator, with the constellation maintainers.**
4. **Joinery collusion ceiling.** The unit-label fix widens the per-listing transfer
   ceiling by 10^6. What is the correct `MAX_LIST_PRICE` in credits once labels are
   truthful? — **Operator.**
5. **Signup grant accounting.** Bring the 100-credit signup mint under cap accounting, or
   exempt it with a recorded reason? — **Operator.**

## Consequences

**Positive.** KAX gains one authorisation layer instead of a permission model per feature,
and — more immediately valuable — the act of writing it has produced a specific, testable
list of the places where the current system's invariants are held up by nothing: the
subject-less ledger write surface, the bypassable revocation, the unaccounted signup mint,
the 10^6 unit label defect, the fee-free small sale.

**Negative.** Policy storage, usage accounting, approval workflow, a reservation state
machine, and more failure modes. Two of those (the approval surface and the statement
endpoint) are new user-facing work, not wiring. The cost is preferable to distributing
economic permission logic across individual features, but it is not small and Phase 1a
exists specifically so that v0.1 does not pay it.

**Honest limitation.** Nothing in this ADR detects collusion, and nothing in it makes the
`authority_decisions` table meaningful without the statement endpoint that lets a human
read what actually moved. Both are named above rather than implied.
