# KAX-ADR-0002 — Commerce Gateway: canonical artifacts into the physical economy

- Status: Proposed (2026-08-15)
- Date: 2026-08-15
- Depends on: KAX-ADR-0001 (Agent Economic Authority) — every consequential commerce action **records an immutable authority decision** under that ADR; the full policy engine is a **v0.2** dependency (KAX-ADR-0001 Phase 1b), not a v0.1 one, and this ADR defines **no** permission model of its own; kannaka-memory ADR-0041 (Resonance Futures — identity tokens, double-entry hash-chained credit ledger, floor ledger)
- Related: NickFlach/Agent-Kax issue #181 (operator decisions, locked 2026-08-13); the Joinery (`lib/joinery.ts`, `lib/joinery-core.ts`) as the existing buy-a-thing-with-credits primitive; `store_listings` as the existing consignment listing
- Code of record today: `artifacts/api-server/src/lib/ledger-core.ts`, `artifacts/api-server/src/lib/ledger.ts`, `artifacts/api-server/src/lib/joinery-core.ts`, `artifacts/api-server/src/lib/joinery.ts`, `artifacts/api-server/src/lib/visibility.ts`, `artifacts/api-server/src/lib/ensureCriticalSchema.ts`, `artifacts/api-server/src/routes/webhooks.ts`, `artifacts/api-server/src/routes/ledger.ts`, `artifacts/api-server/src/routes/identity.ts`, `lib/db/src/schema/artifacts.ts`, `lib/db/src/schema/store-listings.ts`, `lib/db/migrations/0013_credit_ledger.sql`, `lib/db/migrations/0024_unit_furnishings.sql`

## Context

KAX already runs an artifact lifecycle — harvest, score, narrate, drop, publish — and it
already moves value: the credit ledger of ADR-0041 is live, the Joinery sells furniture
for play credits, and the prediction markets settle against the same postings. What KAX
has never done is take a dollar from a human being and put a physical object in the post.

The desired capability is one sentence an agent can say — *commercialize this artifact* —
without knowing anything about DPI, bleed, blueprints, SKUs, mockups, shipping profiles,
tax nexus or chargeback windows. The architectural principle that makes that safe is:

> **The KAX artifact remains canonical. Physical and external products are projections of it.**

This ADR is the second of a pair. KAX-ADR-0001 governs *what an agent is permitted to do*.
This one governs *what happens to money and matter when it does it*. The two must agree on
units, on identity, and on which invariants are policy and which are structural — where
they overlap, the shared text is stated identically in both, deliberately.

Two things are true about the repository today and both shape everything below.

The ledger write surface **is armed in production**. An unauthenticated `POST /api/ledger/grant`
and `POST /api/ledger/trade` both return 401, not 503, which means `KAX_LEDGER_MINT_TOKEN`
and `KAX_LEDGER_TRADE_TOKEN` are set on the deploy. There is no dead money path and no
incident to clean up; the surface works and is gated.

And KAX has already shipped a unit-label defect of exactly the kind this ADR must not
repeat. `splitSale()` in `lib/joinery-core.ts` takes `price` as a **bigint of minor units**;
`lib/joinery.ts` posts `-split.price` straight into the ledger. But `lib/joinery.ts:150`
tells the user "price must be a positive whole number of **credits**", and
`routes/mcp.ts:276` advertises "whole **credits**, up to `MAX_LIST_PRICE`". A piece listed
at 1000 debits 0.001 credits. `MAX_LIST_PRICE = 1_000_000`, presented to agents as
"1,000,000 credits", is one credit. Conservation holds — `splitSale` asserts it, the ledger
enforces sum-to-zero, no value is lost or created — but every human-facing string in the
Joinery is wrong by a factor of 10^6. That is the concrete precedent for the first section
of this document: **a number without a named unit is not a number.**

## Decision

KAX will build the **Commerce Gateway**: a provider-neutral extension of the canonical
artifact system that connects artifacts to KAX-native products, physical products,
print-on-demand fulfilment and — later — external marketplaces. Etsy, Printify and Stripe
are adapters, never the canonical commerce model.

v0.1 will prove exactly one thesis end to end and nothing more:

> One authorized agent causes one verified artifact to become one real physical poster,
> bought by one real human with a card, manufactured and shipped by one real production
> provider, and recorded in one reconciled order row.

A demo listing without fulfilment does not count.

## Units, and the names money goes by

**1 USDC = 100 play_credit = 100,000,000 ledger minor units — i.e. `MINOR_UNITS_PER_CREDIT
= 1_000_000` and `CREDITS_PER_USDC = 100`.** The peg is set once and never changed
(operator decision 3).

Those two must exist as named exported constants in
`artifacts/api-server/src/lib/ledger-core.ts` — the pure, DB-free module that already holds
`GENESIS_HASH`, `HOUSE_ACCOUNT` and `MAX_POSTINGS_PER_TX` — and be pinned by a unit test
that fails if either value moves. Today the 10^6 factor exists only as an unnamed literal
in two places (`routes/identity.ts:29`, `SIGNUP_GRANT_MINOR = 100_000_000n`, and
`routes/ledger.ts:315`, `Number(bal) / 1_000_000` for display), and the 100:1 ratio appears
nowhere in code at all. Both of those sites must be re-expressed in terms of the named
constants, so that the peg has exactly one definition a test can hold down.

For commerce specifically:

- **All commerce money is integer USD cents**, in a column whose name carries its unit —
  `gross_cents`, `item_price_cents`, `tax_collected_cents`. Never a float. Never a bare
  `amount`.
- **Credits and USD cents are never implicitly converted.** There is exactly one permitted
  crossing between the two worlds and it is described under "Where commerce money lives"
  below; it is one-way and it is explicit at the call site.
- Commerce must not copy the Joinery's phrasing. Any user-facing or agent-facing string
  that names a quantity of money names its unit, and the string is derived from the same
  constant the arithmetic uses.

`store_listings.price` is a `real` (float4) and is rounded with `Math.round` at **four**
sites in `lib/joinery.ts` — the catalog (`:128`), `worksForSale` (`:329`), `listingsOfAgent`
(`:355`) and **`purchase()` (`:415`)**. The last is the one that matters: a float is rounded
into the number the ledger then posts. **Commerce adds no rounding site of its own** —
commerce money is integer cents end to end and never crosses `store_listings.price`.

## Platform invariants are not policy

Stated here identically to KAX-ADR-0001:

> **play_credit is non-redeemable.** No endpoint, MCP tool, background job, policy version
> or approval level may convert play_credit to USDC, to fiat, or to any external
> instrument, or move credits between two users absent a delivered good. This is a legal
> posture, not a feature gap.

Launch is a one-way on-ramp: USDC and card in, credits out, nothing back (operator decision
4). Credits are a utility token for platform features — explicitly not an investment, no
yield (operator decision 7).

Operator decision 5 — **no credit transfers between users; prediction markets are the only
peer-to-peer value flow** — is the operator's locked intent, and this ADR carries it as
that rather than as a description of the running system, because shipped code already
departs from its literal reading. `lib/joinery.ts:494-514` posts buyer `trader:*` → seller
`trader:*` plus a maker royalty to a *third* `trader:*`. The boundary that makes that
legitimate is the **goods-purchase-with-a-platform-fee carve-out** named below; stated
precisely, decision 5's rule is *no bare value transfer between two principals* — a
prediction-market settlement or a goods purchase under the carve-out is not one. Restating
decision 5 unqualified would make this ADR false on the day it is written.

These are not defaults and they are not scope lines. A scope line can be un-scoped by a
sprint; a deny-by-default capability implies an operator may grant it. So KAX-ADR-0001
**removes** `credits.transfer`, `usdc.withdraw`, `fiat.withdraw`, `merchant.payout.change`
and `merchant.bank.change` from its capability enumeration entirely rather than listing them
as denied, and the enforcement is structural, in `validatePostings` in `lib/ledger-core.ts`,
as a per-`kind` permitted-account-topology rule:

```
kind                                     permitted topology
---------------------------------------  ------------------------------------
grant                                    house -> trader
escrow                                   house -> amm
trade                                    trader <-> amm
payout                                   amm -> trader | house
joinery, joinery_fee, joinery_royalty    trader -> trader | house
```

with a test in `lib/ledger.test.ts` that **fails** if a `trader -> house` redemption shape
is ever accepted. As shipped, `validatePostings` (`lib/ledger-core.ts`) checks posting
count, bigint amounts, a non-empty `account` and `kind` on every posting, a non-empty
`asset` argument, and `sum === 0n` — and nothing about *which accounts* may face each other
under *which kind*. It would accept a redemption without complaint. An invariant protected
by nothing is one endpoint away from being off.

The carve-out that keeps the shipped Joinery inside decision 5, stated identically to
KAX-ADR-0001, with its boundary drawn where the code can actually hold it:

> **Goods purchase with a platform fee** is a defined carve-out from the no-transfer rule.
> Three conditions, all required, and **only the first two are enforceable at the ledger
> core**:
>
> 1. **A platform fee is taken under a fee `kind`** — the transaction must include a
>    posting to `HOUSE_ACCOUNT` under a `*_fee` kind. *Core-enforceable.*
> 2. **The counterparty is not caller-chosen as a free field** — seller and maker accounts
>    are derived server-side from a listing row, inside `purchase()` (`lib/joinery.ts:390`
>    onward: the listing join at `:393`, the maker resolution and the
>    `SellerCannotBePaid` refusal before any posting is built), never read out of the
>    request body. Contrast `routes/ledger.ts`, where `principal` *is* a request string.
>    *Core-enforceable* as a topology rule.
> 3. **A good is delivered.** The ledger core **cannot see this**. `validatePostings` is
>    pure and DB-free; it has no row to look at. This clause is an **obligation on the
>    caller**, discharged by writing the delivery row in the same logical operation
>    (`unit_furnishings` for the Joinery, the `commerce_orders` row for Commerce), and this
>    ADR says so rather than pretending the core checks it.

So the rule the core actually enforces is: **a bare `trader:* -> trader:*` posting carrying
no fee posting under a `*_fee` kind is refused at the ledger core, not at a route.** Routes
are added by people in a hurry; the core is not. Delivery is enforced one layer up, by the
caller, and is auditable only because the delivery row and the postings share a
deterministic reference.

## Tender rules and the closed loop

This is the section the original draft did not have, and its absence was the most
dangerous thing about it.

1. **Physical checkout accepts card and USDC only.** `play_credit` is not valid tender for
   any physical good, at v0.1 or v0.2.
2. **`play_credit` remains valid tender for KAX-internal digital goods** where KAX is the
   sole obligor and no fiat leaves the platform: Joinery furniture, the arcade, prediction
   stakes. That is what the ledger is for and none of it changes.
3. **"Fiat wallet" is struck from the accepted-instruments list.** KAX holds no customer
   fiat balance, because a KAX-held fiat balance *is* stored value, with the licensing
   consequences that implies.
4. **Refund in kind is absolute.** An order is refunded only in the instrument it was paid
   in. No order paid in credits may ever be reversed to a card, a bank account or a wallet.

The reasoning is worth stating honestly rather than overclaiming. A credits-paid
*first-party* good — KAX sells, KAX ships, KAX is the only obligor — would arguably still
be closed loop. The line is drawn at card/USDC-only anyway, for three reasons: the moment a
third-party merchant exists, credits paid for their goods become KAX transmitting value to
a third party; a credit refund on an order whose cost was denominated in dollars forces a
mixed-currency reversal at a rate somebody has to choose; and keeping one instrument on the
fiat side keeps margin arithmetic in one currency, which is the only way the leg set below
reconciles.

Combined with the order lifecycle's `refunded` and `chargeback` states, the alternative is
a credits-to-dollars round trip — cash-out by another name, against decision 4.

## Merchant model

**v0.1 has exactly one merchant, and that merchant IS the KAX operating entity.** Sole
seller, merchant of record, its own Stripe account, its own bank account, its own Printify
account. KAX remits nothing to anyone and holds no third party's funds at any point in the
v0.1 flow.

That means three things are cut from the v0.1 KAX-native capability list: seller payout
rules, merchant revenue adjustment, and "one merchant may sponsor multiple Agents". All
three are v0.2. There is no merchant entity in the repo today, no payout destination, no
KYC or KYB column anywhere, and decision 4 exists specifically to keep KAX out of
third-party fund handling. First-party-only is the only v0.1 shape that is both reachable
and consistent with #181.

### v0.1 payments: one Stripe account, no Connect

A **single Stripe account** owned by the KAX operating entity, with **no Stripe Connect**.
The operating entity is the sole merchant of record. This is being provisioned in Replit
via the Replit Stripe integration, in **test mode first**.

### v0.2 payments: Connect with direct charges, committed now

The moment a merchant who is not the KAX operating entity lists a physical product,
**Stripe Connect with direct charges becomes mandatory**. This is committed here so it is
not re-litigated later:

- The **merchant is the connected account and the merchant of record.** They bear refunds
  and chargebacks.
- **KAX takes its cut as `application_fee_amount`**, never by holding and disbursing gross.

The reasoning chain, in order:

1. KAX never touches customer funds, so KAX is not transmitting. Stripe is the licensed
   processor and the charge is created on the connected account.
2. Chargebacks land on the connected account's balance, where the goods-liability sits.
3. Merchant payout diligence is performed by Stripe at Connect onboarding, not by KAX —
   KAX records the verdict, it does not make it.

**Destination charges are explicitly rejected.** They make KAX the merchant of record and
put KAX in the position of receiving gross that belongs to somebody else and then remitting
it. Likewise "KAX as merchant of record holding merchant proceeds" is rejected: that is
third-party funds, which is precisely the posture decision 4 was bought to avoid, plus
every chargeback and every state money-transmitter registration that comes with it.

There is a residual that Connect does **not** escape, and pretending otherwise would be
dishonest. **Marketplace-facilitator sales-tax statutes attach to the platform that lists
the goods and facilitates payment.** So KAX is likely the *tax collector of record* even in
a world where the merchant is merchant of record for card purposes. Merchant-of-record and
collector-of-record are separable questions and this ADR answers them separately: v0.2 puts
the merchant as MoR and leaves KAX as the probable tax collector, with the consequence
traced in the custody timeline below.

## Verified identity — one record, two attestation levels

Stated identically in KAX-ADR-0001.

There is **one verified-identity record**, keyed on the **user id**
(`lib/db/src/schema/auth.ts`, `usersTable`) — the human or legal entity. Never on the agent
principal, never on a ledger account string. An agent cannot be a legal person and cannot
hold a bank account.

Resist the tempting shortcut of keying anything on `agents.ownerId` instead. Harvested rows
carry the `KANNAKA_SYSTEM_USER_ID` placeholder (`lib/backfill.ts:256`, the literal string
`"kannaka-system"`), and it is easy to read that as "owned by nobody, therefore permanently
ineligible" — but that placeholder is **not durable**. `maybeClaimKannakaOwnership`
(`lib/backfill.ts:264-340`) reassigns the `kannaka` agent, every artifact, every drop and
several further owner-scoped tables from `kannaka-system` to the operator's user — and
promotes that user to `admin` — the first time they sign in with `KANNAKA_OWNER_EMAIL`.
Ownership is a *bookkeeping* field that moves on a login; it is not an identity fact and no
commerce gate may rest on it.

Two attestation levels hang off that record:

- **`buyer_cip`** — customer identification on someone loading value. This is what satisfies
  operator decision 2's gate at bank-account creation.
- **`payee_kyb`** — know-your-business on someone receiving money out.

The directional rule: **`payee_kyb` satisfies `buyer_cip`; `buyer_cip` does not satisfy
`payee_kyb`.** Never re-ask a merchant who has already cleared Connect onboarding.

**KAX does not perform KYC. KAX records who did.** The stored artefact is the provider's
verdict — `{ provider: 'stripe_connect', account_id, charges_enabled, payouts_enabled,
requirements_currently_due }` — and never the underlying documents. KAX does not want
custody of an identity document and should never acquire it.

A hard schema constraint both ADRs carry: **status fields are `varchar` with app-level
validation, never a `pgEnum`.** `routes/identity.ts:245` states the reason in the source —
"adding pg enum values breaks the Replit deploy flow" — and `user_bots.attached_via`
(migration 0022) is the pattern to copy.

Finally, note what decision 2 presumes and the repo lacks: the "bank account" the KYC gate
attaches to **is an object that does not exist**. The Commerce Gateway must introduce the
account entity itself, not merely add a verification field to something already there.

## Purchase limits

On-ramp purchase caps are a **platform control**, not an agent authority scope. They are
distinct from, and composed with, the per-agent `credits.spend` limits in KAX-ADR-0001;
neither substitutes for the other. An agent under a tight spend limit whose principal
belongs to a user at their daily cap must be refused by the cap, and vice versa.

- Evaluated **per verified identity** — not per principal, not per ledger account.
  Principals are cheap: one per attached bot, and `/auth/token/exchange` auto-provisions
  users with no session at all. A per-principal cap is a cap on nothing.
- Denominated in **USD**, with both a **rolling 24-hour** and a **calendar-month** window.
- **~$100/day at launch** (operator decision 6).

Implementation constraints, carried in both ADRs:

- The accumulator needs an **account dimension** that `houseOutflow(kind, asset, since)`
  does not have — its `WHERE` filters on `account = HOUSE_ACCOUNT` and aggregates across
  everyone.
- **The cap is reserved at admission, not inside the mint's transaction.** This follows
  KAX-ADR-0001's "Evaluation timing" rule 1 and it is forced by the code:
  `postTransaction` (`lib/ledger.ts:71`) takes `pg_advisory_xact_lock(LEDGER_ADVISORY_KEY)`
  for the whole transaction, so *anything* evaluated in the same transaction as the mint is
  serialized behind every unrelated ledger append in the process. Cap accounting must not
  be.
- **The reservation row is the atomicity mechanism.** The caller writes a reservation
  against the per-identity usage row — under a **row-level lock on that usage row**, never
  the ledger's global advisory lock — *before* `postTransaction` opens. The mint then
  commits against that reservation, and the only authority/limit work permitted inside the
  ledger transaction is the **single cheap indexed read** that confirms the reservation
  exists, is unconsumed, and has not expired. An abandoned reservation expires; it never
  leaves a mint uncapped, because no mint may open without one.
- **`houseOutflow` is explicitly not the pattern to extend.** Its own comment concedes
  "best-effort (a small race window across concurrent grants is acceptable for play
  credits)". That is a defensible trade for play credits and an indefensible one once the
  units are dollars.
- The **signup grant** in `routes/identity.ts` (`SIGNUP_GRANT_MINOR = 100_000_000n`) must
  either be brought under the same accounting or explicitly exempted with a named reason
  recorded in code. Today it is the one mint no cap sees.

## Economic models: native and external are different businesses

**KAX-native commerce.** KAX participates in checkout, so KAX can enforce transaction fees,
tax integration, refund accounting, an order record and a support workflow. This is a
marketplace model. (Seller payout rules are v0.2 — see Merchant Model.)

**External commerce** — Etsy, Shopify, future channels. The merchant owns the seller
account, the channel controls checkout and typically pays the merchant directly, so KAX
cannot assume it can deduct a percentage. External commerce is monetized through
subscription, usage fees, premium automation, partner agreements. The two models must never
be conflated.

| Channel | Primary KAX economic model |
|---|---|
| KAX-native | transaction take rate |
| External marketplace | SaaS / usage / partner |
| POD provider | partner / affiliate — **bounded by [Provider and product selection governance](#provider-and-product-selection-governance)** |
| Agent-to-agent | play_credit only; x402/USDC is an **on-ramp into credits**, never an A2A settlement rail |

That last row matters. The arrow runs **USDC → Resonance Trust → play_credit, in one
direction only**, and **no USDC ever moves between two KAX principals**. Routing USDC
between two agents would be KAX transmitting value between two third parties, which is
exactly what decision 4 forbids. x402 / USDC-on-Base is the primary agent payment on-ramp;
L402/Lightning is the alternate rail (operator decision 1).

## Human retail checkout

Card checkout is a **Stripe hosted Checkout Session** for v0.1: server-created, the browser
redirects to Stripe's page, Stripe redirects back. PCI scope is SAQ A and no publishable key
is needed client-side.

Being honest about the cost: the redirect **breaks immersion**. A buyer standing in KAX's 3D
city is thrown out to a Stripe-hosted page and back. That is accepted for v0.1 because the
alternative — Stripe Embedded Checkout — is more integration surface on the critical path of
a one-transaction proof. Embedded Checkout is a v0.2 polish item and is listed as such.

Environment names, already agreed with the operator, to be used exactly:

| Name | Purpose | v0.1 |
|---|---|---|
| `STRIPE_SECRET_KEY` | server-side Stripe API | required |
| `STRIPE_WEBHOOK_SECRET` | verify `/api/webhooks/stripe` | required |
| `KAX_COMMERCE_ENABLED` | feature flag, **default off** | required to write |
| `KAX_PRINTIFY_API_TOKEN` | Printify Personal Access Token | required |
| `KAX_PRINTIFY_SHOP_ID` | which Printify shop to publish into | required |

Success and cancel redirects reuse an **existing** base-URL variable. No new base-URL
variable is invented, and the base is never taken from request headers.

Be specific about *which* existing one, because the repo has two and they are not
interchangeable. Checkout `success_url` and `cancel_url` derive from the **same precedence
`resetLinkBase()` uses** (`routes/auth-email.ts:209-216`): `KAX_PUBLIC_URL`, else
`REPLIT_DEV_DOMAIN` / the first entry of `REPLIT_DOMAINS`. **Never `PUBLIC_APP_URL`** — that
variable is used only by the email notification handlers
(`lib/eventHandlers/dmReceived.ts:167`, `proposalCreated.ts:101`) and each reads it as
`process.env.PUBLIC_APP_URL ?? ""`, which silently degrades to a *relative* URL. A relative
`success_url` is rejected by Stripe at session creation, and the failure would surface as a
broken checkout rather than as a missing variable.

And unlike `resetLinkBase()`, commerce takes **no hardcoded final fallback**: an
unresolvable base is a **hard refusal to create the Checkout Session**, not an empty string
and not `https://kax.replit.app`. Sending a buyer back to the wrong host after a real charge
is worse than not taking the charge.

The Stripe webhook endpoint is **`/api/webhooks/stripe`**, matching the existing
`/api/webhooks/openbotcity` convention. The path prefix is load-bearing, not cosmetic — see
Deployment posture.

## Cash flow and custody timeline

One $39 poster, traced end to end, with every point money is held, by whom, and for how
long. This is the section that decides whether KAX is holding third-party money.

**Each merchant connects their own POD account and is billed directly by the provider.**
KAX never fronts manufacturing cost and never carries a merchant receivable. In v0.1 this is
trivially satisfied because KAX *is* the merchant. In v0.2 it is a **hard constraint**: a
single KAX-held Printify connection serving many merchants would mean KAX pays the
manufacturer at T+0 and recovers it by netting against payout — which is holding and
disbursing merchant funds, the exact exposure decision 4 was bought to avoid, arriving
through a fulfilment adapter instead of through a payments decision.

### v0.1 flow — one Stripe account, no Connect

There is no connected account, no platform balance and **no `application_fee` object at
all** in v0.1. There is one account, and the whole charge settles into it. Saying otherwise
would describe a Connect topology that is not being provisioned.

```
  buyer's card
      │  $39.00 + tax, authorized and captured at checkout
      ▼
  STRIPE                                    holds full charge    0–2 business days
      │  processor fee deducted at settlement                    immediate
      ▼
  KAX OPERATING ENTITY — one account, one balance                ~2 days to payout
      │  the entire net. No transfer leg. No application fee.
      │  Fee/net/margin are computed by KAX for the ORDER ROW;
      │  Stripe performs no split.
      ▼
  TAX COLLECTED
      │  if KAX is collector of record, this amount is a LIABILITY,
      │  segregated, never available for operating use
      └────────────────────────────► state remittance            up to ~50 days

  POD COST
      the operating entity's own stored payment method,
      charged by Printify at order submission                    consumed at T+0

  CHARGEBACK EXPOSURE on the full charge                         ~120 days
      lands on the operating entity — it is merchant of record
```

The consequence worth stating: in v0.1 the `platform_fee` and `merchant_net` legs of the
order row are **accounting facts KAX computes about its own money**, not movements Stripe
made. They still belong on the row — the margin arithmetic and the v0.2 migration both need
them — but nothing external corroborates them until Connect exists.

### v0.2 flow — Connect with direct charges

```
  buyer's card
      │  $39.00 + tax, authorized and captured at checkout
      ▼
  STRIPE                                    holds full charge    0–2 business days
      │
      ├── application_fee → KAX platform balance                 ~2 days to payout
      ├── merchant net    → connected account balance            ~2 days to payout
      └── processor fee   → Stripe, deducted at settlement       immediate
      │
      ▼
  TAX COLLECTED
      │  if KAX is collector of record, this amount is a LIABILITY,
      │  segregated, never available for operating use
      └────────────────────────────► state remittance            up to ~50 days

  POD COST
      merchant's own stored payment method, charged by Printify
      at order submission                                        consumed at T+0

  CHARGEBACK EXPOSURE on the full charge                         ~120 days
      lands on the connected account — it is merchant of record
```

Commitments this ADR makes:

- **Who bears the Stripe fee (v0.2):** the connected account. Chosen so that merchant
  economics are self-contained and a merchant's margin does not depend on a platform-side
  deduction they cannot see. In v0.1 the question does not arise: the operating entity bears
  it because the operating entity is the only party.
- **KAX's application fee (v0.2)** is taken gross via `application_fee_amount`, at a rate
  recorded on the order row together with the basis it applied to (see the leg set below).
  **The rate itself is not set by this ADR.** The repo's only existing rate is
  `HOUSE_BPS = 1000` (10%), a hardcoded module constant at `lib/joinery-core.ts:27` with
  no fee table behind it; whether commerce uses that rate or another is an **operator**
  decision, to be made and recorded before the first charge. v0.1 records the same fields
  with no Stripe object behind them, per the v0.1 flow above.
- **Under Stripe Connect the platform is liable for negative connected-account balances.**
  KAX therefore carries residual chargeback liability even with direct charges. The
  mitigation committed here is a **merchant balance floor / reserve** held by Stripe against
  the connected account, sized before the first non-KAX merchant is onboarded. This is a
  v0.2 obligation, named now so it is not discovered during a dispute.
- The two **longest** holds in the flow are sales tax (up to ~50 days) and the chargeback
  window (~120 days). Neither is money KAX may treat as revenue.

## Where commerce money lives — and why it is not in `credit_ledger`

Three statements, so nobody reopens this.

**1. `credit_ledger` is not extended with a fiat asset.** The reasons are structural facts
about the ledger as built, not preferences:

- `CREATE UNIQUE INDEX credit_ledger_prev_hash_uq` (migration 0013) makes the chain
  **strictly linear**. A `usd` asset would interleave its entries into the play_credit
  chain. It could not then be audited, frozen, or migrated independently of play credits.
- `LEDGER_ADVISORY_KEY = 0x1ed6e401` serializes **every** append process-wide. Every poster
  sale would queue behind every prediction trade, and vice versa.
- `verifyChain` is **asset-blind**: it walks every row in sequence and recomputes hashes.
  There is no way to verify the dollar chain without verifying the credit chain.
- The overdraft guard is an exact compare against `HOUSE_ACCOUNT` (`p.account !==
  HOUSE_ACCOUNT`), so a `tax_liability:<jurisdiction>` account — which must be allowed to
  hold a liability — would be rejected the first time it went the wrong way.
- A posting row has no order id and no indexed settlement reference. Nothing in the chain
  can be joined to a Stripe payout report.

**2. v0.1 adds no ledger at all.** `commerce_orders` **is** the commerce record of truth,
and the normalized commerce event is a projection computed from it. This is stated
explicitly because the original success criterion's phrase "reconciled ledger record" reads
as though `credit_ledger` were involved. It is not, and it must not become so by drift.

**3. If a `commerce_ledger` is introduced in v0.2** it is a **separate double-entry table**,
in integer minor units of an explicit ISO currency (USD cents), with:

- its own account grammar: `customer`, `merchant:<id>`, `kax_platform`, `processor:stripe`,
  `pod:<provider>`, `tax_liability:<jurisdiction>`;
- first-class **indexed** external-reference columns;
- an explicit reversal vocabulary — `refund`, `partial_refund`, `chargeback`,
  `chargeback_reversal`, `tax_adjustment`, `reprint_cost`;
- and a **reconciliation query against `credit_ledger` shipped in the same pull request**.
  The repo already carries two unreconciled ledgers; adding a third for one order would
  repeat a defect that is already known.

**`floor_ledger` is unrelated to money and must not be extended for commerce.** Its
`credits` column is `real` (float4) and describes OpenBotCity's separate economy
(`lib/db/src/schema/floor.ts:24`).

**Exactly two permitted crossings between the fiat and credit worlds. Both run fiat →
credit, and both are minted the same way: an ordinary `house -> trader` grant.**

1. **The on-ramp.** A human or principal buys credits with card or USDC at the fixed peg,
   under the platform purchase caps of the "Purchase limits" section. This is operator
   decision 1's primary rail and it is a fiat-to-credit crossing like any other — it mints,
   so it is capped, and it carries a `ref` to the purchase that funded it.
2. **A creator electing their share as credits.** If a creator elects to take their share of
   a commerce order as play_credit, KAX buys credits on their behalf at the fixed peg and
   posts the grant carrying a `ref` to the `commerce_orders` row. (Whether a *third-party*
   creator may be paid this way at all is the open policy question under "Derivative
   lineage" — the operator decides.)

Nothing else crosses. **Credits → fiat is forbidden at every policy version, in every
direction, by every actor**, and it is structurally absent rather than denied: the topology
table above has no `trader -> house` redemption shape to grant.

## The commerce event: a signed, balanced leg set

`{"gross": {"amount": 39, "currency": "USD"}}` is not a record of anything. Thirty-nine is
neither the amount charged (tax and shipping are on top) nor the amount kept (fees and
manufacturing come off), so it reconciles to no external report and margin cannot be derived
from it.

`commerce.order.paid` therefore carries a **signed, balanced leg set**. Every amount is
`{ entity, amount (integer USD cents), currency }`, and where an amount is a rate, it also
carries `rate_bps` **and the basis it applied to**.

The important discipline is that the record has **three distinct groups**, and only one of
them sums to zero. Conflating them produces an invariant that can never hold: the
composition of the charge and the distribution of the charge describe the *same money twice*,
and the print cost is not in the charge at all.

**(a) Charge composition — its own identity, not part of the balanced set.**

```
item_price + shipping_charged + tax_collected === customer_charge
```

| Amount | Carries |
|---|---|
| `item_price` | goods subtotal, ex-tax, ex-shipping |
| `shipping_charged` | what the customer paid for delivery |
| `tax_collected` | + `tax_jurisdiction`, `tax_rate_bps`, `collector_of_record ∈ {kax, merchant}` |
| `customer_charge` | full authorized amount; reconciles to the Stripe charge |

**(b) The balanced settlement set — this is the sum-to-zero invariant**, the same discipline
`validatePostings` already enforces for credits:

```
+ customer_charge
- tax_collected
- processor_fee
- platform_fee
- merchant_net
=== 0
```

| Leg | Sign | Carries |
|---|---|---|
| `customer_charge` | + | reconciles to the Stripe charge |
| `tax_collected` | − | removed first — it is a liability, never anyone's revenue |
| `processor_fee` | − | + `bearer ∈ {platform, merchant}` |
| `platform_fee` | − | + `rate_bps` **and** `basis` — 8% of `item_price` is not 8% of `customer_charge` |
| `merchant_net` | − | the residual, and the only leg defined as a residual |
| `settlement_refs` | — | **indexed**: `stripe_payment_intent`, `stripe_transfer`, `stripe_application_fee`, `pod_order_id`, `tax_provider_txn` |

In v0.1 `platform_fee` and `merchant_net` accrue to the same entity and no Stripe transfer
or application-fee object exists behind them (see the v0.1 custody flow). The identity still
holds and the fields are still recorded, because they are what v0.2 migrates and what margin
is computed from.

**(c) POD cash flow — recorded, and explicitly OUTSIDE the sum-to-zero invariant.** Printify
charges the merchant's stored payment method at order submit; that money never passes
through the Stripe charge, so it cannot be a leg of a set that balances against
`customer_charge`. It is a separate cash flow, on its own clock.

| Amount | Carries |
|---|---|
| `fulfillment_cost` | + `payer ∈ {kax, merchant}`, `paid_at` |
| `fulfillment_shipping_cost` | what the provider charged to ship, + `payer`, `paid_at` |

Derived — margin joins (b) and (c), which is precisely why they are recorded separately:

```
margin = item_price
       - platform_fee
       - processor_fee            (only when bearer = the party margin is computed for)
       - fulfillment_cost
       - fulfillment_shipping_cost
```

**In v0.1 these are columns on `commerce_orders`, not rows in a ledger table.** The event is
a projection of the row.

## Commerce state machine

Commerce state is separate from artifact publication state. An artifact being publicly
visible does not imply it is ready for commerce, and the two predicates are separate by
design.

State is keyed on **`(artifact_id, product_spec_id, channel)`**. Eligibility is inherently
per-product: the same artifact can be a native pass as a sticker, need upscaling as a 12×12
poster, and be flatly unsuitable as a 24×24 canvas. A single per-artifact commerce status
would be a lie about two of those three.

| From | Event | To |
|---|---|---|
| `not_evaluated` | rights preflight passes | `rights_checked` |
| `not_evaluated` | rights preflight fails | `rights_blocked` |
| `not_evaluated` | rights preflight inconclusive | `review_required` |
| `rights_checked` | asset measured, meets spec | `asset_checked` |
| `rights_checked` | fetch / decode / sentinel / too small | `asset_insufficient` |
| `asset_checked` | product spec satisfied at `minimum_ppi` | `product_eligible` |
| `asset_checked` | product spec not satisfied | `asset_insufficient` |
| `product_eligible` | **human merchant approves** (no automated edge) | `merchant_approved` |
| `merchant_approved` | live re-check passes, content hash matches | `channel_ready` |
| `merchant_approved` | live re-check fails **or** content hash differs | `product_eligible` |
| `channel_ready` | provider accepts, listing goes live | `published` |
| `channel_ready` | provider rejects the print area / file | `provider_rejected` |
| `channel_ready` | channel policy refuses | `channel_policy_blocked` |
| `published` | merchant or agent takes it down | `unpublished` |
| `published` | permanently withdrawn | `discontinued` |
| `published` | provider-initiated, async | `provider_rejected` |
| *any* | **creator bot revoked** | `rights_blocked` (+ unpublish, + cancel queued fulfilment) |

### Re-approval semantics

**Rights assertions are time-bound snapshots, not durable facts.** Every input to
`creator_control` is revocable: `user_bots.revoked_at` can be stamped at any moment, an
attachment can be deleted, OBC can withdraw a verification.

So each assertion carries `asserted_at` and `expires_at`, and `creator_control` is
**re-evaluated from live data — never from the recorded assertion** — at two points: the
`merchant_approved -> channel_ready` transition, and again immediately before fulfilment
submission.

The merchant approval row stores an **`approved_content_hash`** over
`(source public_url, sha256 of the bytes as fetched at approval time, print_master_id,
product_spec_id, price)`. Any publish or fulfilment step recomputes it. **On mismatch the
state transitions back to `product_eligible` and requires fresh human approval.** It does
not warn and continue.

The reason for pinning to content rather than to a timestamp is that **KAX does not control
the asset host.** `public_url` points at OBC's Supabase bucket. Those bytes can be replaced
with no KAX-side write, no `updated_at` change, and nothing at all to notice — the merchant
approved a photograph and the poster prints something else.

One implementation hazard to name: the revocation gate lives in `refuseIfRevoked`
(`lib/actor.ts:81-90`), and it is reached from the two *actor-resolution* doors —
`resolveActor`'s agent-token branch and `agentForActor` (`lib/actor.ts:197`) — and from
nowhere else. That covers a request that arrives as an agent or as its owner's session. It
covers nothing that reaches commerce without resolving an actor at all: a background job, a
service-token surface, a future MCP façade calling the library directly. **The Commerce
Gateway must call the revocation check itself, at its own library boundary**, so every
façade over it gets the gate rather than only the doors that happen to have it today.

## v0.1 eligible set

The commercializable population in v0.1 is defined precisely:

> Artifacts where `creator_bot_id IS NOT NULL`, **and** `creator_bot_id` appears in
> `user_bots` with `revoked_at IS NULL`, **and** the requesting principal owns that
> `user_bots` row.

Concretely, that is an `EXISTS` against `user_bots` keyed on
`(obc_bot_id = artifacts.creator_bot_id, user_id = the requesting principal's userId,
revoked_at IS NULL)`. **`agents.ownerId` is not an input to the predicate**, and neither is
`artifacts.ownerId` — the eligible set is about who holds the *attachment*, not about who
holds the row.

That distinction is load-bearing enough to state the reason. Harvested artifacts arrive from
the OBC partner feed carrying a `creator_bot_id` and **no corresponding `user_bots` row at
all**; `user_bots` rows are only ever written by a signed-in human's attach, through the
`/auth/agent` challenge-attach flow (`routes/auth-agent.ts:247`) or the legacy
`obc_agent:` session backfill (`middlewares/authMiddleware.ts:88`). Nothing in
`lib/harvesterJob.ts` writes one. So harvested bots fail the predicate because the
attachment does not exist — **not** because of who owns the agent row. Building
`commerceEligibleWhere()` from an ownership filter such as
`agents.ownerId != 'kannaka-system'` would produce a materially different set, and one that
loses its exclusions entirely the moment `maybeClaimKannakaOwnership` runs (see "Verified
identity").

The consequence, stated plainly: **the v0.1 pilot must run against an artifact created by a
bot the pilot merchant has personally attached** — most likely a Kannaka or operator bot the
operator has attached to their own account — **not against the general harvested
catalogue.**

**Appearing on a public KAX storefront does not imply commercial eligibility.** Those are
two different questions and they get two different answers on purpose.

Commerce eligibility is therefore a **third named predicate, defined once** in
`artifacts/api-server/src/lib/visibility.ts` beside `isArtifactPublic` and
`publicArtifactWhere` — e.g. `commerceEligibleWhere()` — and never re-derived ad hoc in a
route. The repo already carries **two contradictory answers** to "is this artifact public":
`lib/visibility.ts` requires a published drop plus a `narrated | dropped` status, while
`routes/agent-storefront.ts:328-337` (`agentWorksWhere`) deliberately applies neither,
because the storefront *is* the agent's harvested body of work. Both are correct for their
purpose. A fourth ad-hoc copy of "is this sellable" would not be.

And the warning that makes it stick: the existing publication gates are protected only by
**source-string tests** that read route `.ts` files and assert things like
`expect(FN).toContain("dropId} IS NOT NULL")` (`lib/publicRouteGating.test.ts`). Those pass
on a rename, on a call moved into dead code, and on a predicate that is constructed but
never applied. **Commerce eligibility gets a behavioural test against the real Postgres CI
service instead.**

## Stage 1 — rights preflight

Commerce does not begin by generating products. It begins by determining whether
commercialization is allowed at all, because everything downstream is expensive.

`commercialization_allowed = true` is not a rights model. KAX models rights as **assertions
with evidence**:

```json
{
  "artifact_id": 817,
  "agent_id": "kax:agent:<uuid>",
  "rights": {
    "status": "partial",
    "assertions": [
      { "type": "creator_control",  "subject": "kax:agent:<uuid>",
        "evidence": { "user_bot_id": "…", "attached_via": "wallet",
                      "attached_at": "…", "user_id": "…", "revoked_at": null } },
      { "type": "generation_terms", "source": "merchant_attestation",
        "attesting_user_id": "…", "asserted_at": "…", "policy_version": "1",
        "text": "<verbatim attestation>" },
      { "type": "derivative_lineage",
        "lineage": { "status": "unknown", "parents": [] } }
    ]
  }
}
```

Note the principal form. The canonical principal is **`kax:agent:<uuid>`**, produced by
`principalForClaims` in `lib/actor.ts:51-54`. The form `obc:bot:<uuid>` used in the original
draft **exists nowhere in this codebase** and must not be introduced.

### Who actually produces each assertion

An assertion with no named producer is not added to the schema. **A field that will be
defaulted to `true` is worse than an absent field**, because a defaulted rights field reads
exactly like a checked one.

| Assertion | Producer | v0.1 verdict |
|---|---|---|
| `creator_control` | automated query | **AUTOMATED — the only one** |
| `generation_terms` | nothing in KAX | **MERCHANT SELF-ATTESTATION**, evidence recorded |
| `derivative_lineage` | nothing in KAX | **NOT PRODUCIBLE** — tri-state, default `unknown` |
| `likeness_review` | nothing in KAX | **OUT of v0.1** |
| `trademark_review` | nothing in KAX | **OUT of v0.1** |

**`creator_control`** is the automated one. The check is: `artifacts.creator_bot_id IS NOT
NULL`, **and** it appears in `user_bots` for the requesting principal's `userId`, **and**
that row's `revoked_at IS NULL`.

Be precise about what that proves. It proves **the requesting principal controls the bot
that OBC names as the creator.** It does **not** prove the bot created the work.
`creator_bot_id` arrives from OBC's partner feed (`lib/harvesterJob.ts`) and KAX never
independently verifies authorship. Anyone reading a `creator_control: verified` assertion
should read it as an attribution-and-control claim, not an authorship proof.

The opaque evidence string `"verified_kax_attachment"` is replaced by the structured record
shown above, carrying `user_bots.attached_via` (`'wallet' | 'session'`, migration 0022),
`attachedAt` and the `userId` — because **attach strength varies**. Any signed-in session
may attach a bot; only `mayChangeBot` enforces a floor on *changing* one. A rights gate that
cannot tell a wallet-proven attachment from a session attachment is discarding the one
signal it has.

**`generation_terms`** is not producible. KAX stores no model, no provider, no prompt and no
licence field anywhere in the schema. v0.1 therefore takes a **merchant self-attestation**
and records the evidence: attesting `userId`, timestamp, the **verbatim** attestation text,
and the policy version it was taken under. That is a real record of who said what and when,
which is worth having; it is not a verification, and the ADR does not call it one.

**`derivative_lineage`** — see the next section.

**`likeness_review` and `trademark_review`** — see the section after that.

### Authority, not a parallel permission model

Every consequential Commerce Gateway action **records an immutable authority decision; the
full policy engine is a v0.2 dependency, not a v0.1 one.** The Commerce Gateway maintains no
independent permission model.

This is the matching half of **KAX-ADR-0001's Phase 1a**, and it is stated here because the
sequencing error it prevents is the largest one available in this pair of documents. In v0.1
the authority question is a **single** one — *may this actor commercialize this artifact* —
answered **with no new subsystem**: `resolveActor(req)` + `isRevoked` + the existing
`agentWorksWhere(agent)` predicate (`routes/agent-storefront.ts`), plus **one immutable
`authority_decisions` row per consequential action**. Everything else is DENY, hard-coded,
with no policy row at all.

Policy documents, versioning, per-channel scope, amount limits and approval modes are
**KAX-ADR-0001 Phase 1b**, and Phase 1b is a v0.2 dependency of this ADR. Nothing in the
v0.1 critical path below waits on the Authority service existing. An implementer who builds
the policy engine first has built the wrong thing first.

The capability vocabulary below is therefore the *shape v0.2 grows into*, not a v0.1 build
order. KAX-ADR-0001 splits its capability list into three labelled groups, and the shape
matters here:

1. **Delegation** — what an agent may do with authority the principal already has:
   `commerce.product.create`, `commerce.listing.create_draft`, `commerce.listing.publish`,
   `commerce.listing.unpublish`, `commerce.price.change`, `credits.spend`.
2. **Rights preconditions — computed, never granted.** `artifact.commercialize` is renamed
   **`commerce.propose_from_artifact`**, because whether *the artifact* may be
   commercialized is the **output of this rights preflight**, not a policy bit on an agent.
   Granting the delegation can never substitute for a rights PASS. The old name read as a
   property of the artifact while being listed as a per-agent grant — and with no
   rights/licence/commercial-use column anywhere in the repo, a policy edit would have stood
   in for a rights determination that had never been made.
3. **Structurally absent** — the platform invariants above. Not denied. Absent.

One more, on refunds, decided rather than left open: **`commerce.refund.issue` is out of
scope.** It names an action no code path in this repository can perform. `credit_ledger` and
`credit_ledger_txids` both reject `UPDATE` and `DELETE` at the trigger level (**migrations
0013 and 0014** — `0013_credit_ledger.sql` carries the ledger's trigger,
`0014_credit_ledger_txids.sql` the registry's), and nothing in the repo emits a compensating
posting. A refund is therefore not a permission question at all until someone designs a
forward-only correction: a reserved compensating `kind`, its own topology rule, and a link
back to the transaction it reverses. Until that design exists the capability is not named.
**Real-money refunds in v0.2 are handled by the connected account as merchant of record**,
not by the credit ledger.

## Merchant indemnity, and the reviews KAX cannot perform

**`trademark_review` and `likeness_review` are out of v0.1.** Both move to the "explicitly
out of scope" list and to v0.2's "richer rights evidence".

Nothing in KAX can produce either one: no vision model, no marks database, no screening
integration, no reviewer role. Leaving them in the v0.1 assertion set guarantees they ship
as unchecked booleans defaulting to `clear`, which is the worst possible outcome for the two
highest-liability checks in the document.

They are replaced, for v0.1, by a **merchant indemnity attestation** — taken once at
merchant onboarding and re-affirmed per commercialization request, recorded with attesting
`userId`, timestamp, verbatim text and version — plus an **operator takedown path**: a
transition to `rights_blocked` that unpublishes the listing and halts fulfilment.

> KAX does not screen for marks or likeness in v0.1. The merchant warrants, and KAX can
> withdraw.

Two consequences to be honest about. First, the `review_required` state implies a review
queue, and `users.role` is a two-value enum (`'user' | 'admin'`, `lib/db/src/schema/auth.ts:15`)
with no reviewer role and no permissions table — so in v0.1 `review_required` means "an
admin looks at it", or it is deferred entirely. Second, the attestation needs a merchant
entity to attach to, and `agent_storefront_settings` is **cosmetics only**: `displayName`,
`tagline`, `heroImageUrl`, `accentColor`, `themeVariant`, `socialLinks`, `customDomainHint`,
`customCssVars`. The "MERCHANT PROFILE" box in any merchant diagram **must be built, not
wired**.

## Derivative lineage

**No inbound lineage exists.** A repo-wide search for `parent_artifact`, `derived_from`,
`remix_of`, `source_artifact` and `lineage` returns only JWT token-lineage hits. There is no
column, no table, and no upstream field KAX receives.

So `"parents": []` is replaced by an explicit tri-state:

```json
"lineage": { "status": "unknown" | "declared" | "kax_derived", "parents": [] }
```

**`unknown` is the default for every harvested artifact and must never be read as "no
parents".** An empty array inside a rights gate reads as verified-clean, which is exactly
backwards — it is the absence of information, presented as the presence of a clean result.

**Forward-only from v0.1.** KAX records lineage only for assets KAX itself produces —
`print_master.source_artifact_id` and its like — because those are the only edges KAX can
assert truthfully.

**No v0.1 revenue split may depend on lineage.** This is a hard constraint, not a
preference, and "revenue-split obligations" is removed from the v0.1 lineage requirements.
The repo's only split is `HOUSE_BPS = 1000` / `MAKER_ROYALTY_BPS = 1000`, hardcoded as
module constants at `lib/joinery-core.ts:27` and `:29`, with no fee table and no per-artifact
terms.
And it has a silent failure mode: when the maker cannot be resolved to an agent with an
`obc_bot_id`, `lib/joinery.ts:508-514` folds the royalty into the seller's posting, leaving
**no ledger record that the maker went unpaid** — the transaction balances, the money moves,
and nothing anywhere says a royalty was owed. A lineage-driven split would inherit that
invisibly.

The unresolved policy question, stated as unresolved rather than implied solved: **paying a
third-party creator a real-money share has no rail under decision 4.** The two candidate
answers — a house-minted play_credit grant at the fixed peg, or making the creator a Connect
sub-merchant — are v0.2 decisions with materially different regulatory weight. **The
operator decides.**

## AI disclosure

Promoted out of the deferred Etsy policy gate and into v0.1, with its own section, because
v0.1 sells a physical object to a real human through KAX's own checkout — which is exactly
where a point-of-sale disclosure obligation attaches. Deferring it to a v0.3 channel adapter
would mean v0.1's one real transaction ships without it.

- A **`machine_generated` flag defaults to TRUE** for every artifact reaching Commerce
  Gateway. Every connector in the system ingests agent-created work; the burden is on any
  future non-AI path to prove otherwise, not on this path to prove the obvious.
- The disclosure text KAX can honestly make is **"AI-generated on OpenBotCity by agent
  `<name>`"**. KAX **cannot name a model or a provider** and this ADR says so rather than
  implying a model attribution there is no field for.
- The disclosure is rendered on the KAX-native product page alongside the *Sold by / Created
  by / Powered by / Fulfilled by* block, is included in the order record, and is carried
  into any future channel adapter's listing payload.
- **`connector_id` is not an acceptable proxy.** It records provenance-of-ingest, not
  provenance-of-creation.
- This is a **precondition** for external marketplace work, not a consequence of it.

Implementer caution: `formatArtifact()` in `routes/artifacts.ts:239` spreads the entire row
(`...a`) and is the shared formatter for the public storefront, the works listing, drops and
the dashboard. A disclosure column added to `artifacts` is therefore published on every
public surface the same day. For disclosure that is acceptable — but it should be a
deliberate choice, not a side effect noticed later.

## Stage 2 — printability preflight

Printability is load-bearing. A 1024×1024 image supports 3.41 inches at 300 PPI; a 24-inch
print at 300 PPI needs 7200 pixels. Assuming otherwise ships a blurry poster to a paying
customer.

### The metadata does not exist

**`source_asset` metadata does not exist today.** The `artifacts` table has 32 columns
(`lib/db/src/schema/artifacts.ts`) and not one of them is width, height, format, byte size,
checksum or duration. Nothing in the repo can decode an image. **One** connector
(`connectors/civitai.ts:32-33`) receives optional `width` / `height` from upstream and KAX
discards them; the **OBC partner feed — the only source that matters for the v0.1 eligible
set — supplies none at all**, and `lib/harvesterJob.ts` writes none.

It must be introduced as a **new side table, `artifact_print_assets`, keyed by
`artifact_id`** — **not** as columns on `artifacts`. The reason is the `formatArtifact()`
row-spread noted above: any column added to `artifacts` is on every public surface the same
day, and print custody metadata (fetch URLs, checksums, byte sizes) is not something to
publish by accident.

Minimum v0.1 field set:

| Field | Source | Note |
|---|---|---|
| `width_px`, `height_px` | decoded from bytes | the actual gate |
| `format` | decoded from bytes | |
| `has_alpha` | decoded from bytes | |
| `byte_size` | fetch | custody record |
| `sha256` | fetch | **required for approval pinning** |
| `fetched_at` | fetch | custody record |
| `source_url_at_fetch` | fetch | custody record |
| `color_space` | **not reliably derivable** | nullable; see below |

`color_space` is nullable on purpose. Most OBC PNGs carry no ICC profile, so the honest rule
is: **unknown means assume sRGB, and record that the assumption was made.** A column that
silently reads `"sRGB"` for both a measured profile and a guess is a column that will
eventually justify a bad print.

### Two hard source-selection rules

**(a) The printability engine MUST measure `public_url`, never `thumbnail_url`.**
`lib/harvesterJob.ts:88` writes `thumbnailUrl: pa.thumbnail_url ?? pa.public_url` — so for
many rows the thumbnail *is* the full asset, and for the rest, measuring the thumbnail would
approve a print the source cannot support.

**(b) `public_url` and `thumbnail_url` are not always URLs.** OBC uses `inline:` sentinels
(see `routes/showcase.ts:67`, which skips them). Validate against `/^https?:\/\//i` **before**
any fetch, and resolve a sentinel to `asset_insufficient` — never to a fetch attempt.

### Failure is not only "too small"

`asset_insufficient` must cover **could not fetch**, **could not decode**, and **sentinel,
not a URL**, as well as "smaller than the spec requires". Each records which one it was.

### Corpus policy: lazy, on demand, never a backfill

Measurement happens **at commercialization request time**, for the one artifact being
commercialized. There is **no bulk backfill** of the harvested corpus. Three reasons:

- The upstream host **aggressively 429s**. `lib/creatorDirectory.ts` needs up to 6 attempts
  with exponential backoff (capped at 30s), honours `Retry-After`, and paces 300 ms between
  pages just to walk a gallery. A corpus-wide byte fetch would be an order of magnitude
  worse.
- Most of the corpus is not eligible anyway — see the v0.1 Eligible Set.
- A backfilled measurement can go **stale against a URL KAX does not control**, and a stale
  measurement in a print gate is worse than no measurement.

## Print masters, upscaling, and what KAX actually holds

**v0.1 accepts only `native_pass` products.** Pick a poster size the source artifact already
satisfies at the product's `minimum_ppi`, and refuse everything else with
`asset_insufficient`. No upscaling, no quality review, no derived asset.

The fact that collapses the rest of this problem: **Printify's `POST /v1/uploads/images.json`
accepts an image by URL** and stores the file in the merchant's media library. So v0.1 hands
Printify the artifact's existing `public_url` and needs **no KAX-side object storage, no
upscaler, and no native image dependency**.

That also answers the reprint concern honestly: the print file lives durably at Printify from
the moment of upload, which is what makes a reprint possible without KAX holding custody of
anything.

Which means the Authority Map's line "Product source image → KAX" is **false today** and is
amended:

> **Product source image** — KAX is authoritative for *which image*. The print file is held
> by the fulfilment provider once uploaded. Until that upload happens, KAX holds only a URL
> on a host it does not control (OBC's Supabase bucket, per the arcade allowlist in
> `routes/arcade.ts:32`).

KAX must still read the bytes once, for two things and only two: **width/height**, and a
**sha256** to pin merchant approval. The mechanism is a single **size-capped, https-only,
allowlisted streaming fetch** that computes both and **discards the bytes**, reusing the SSRF
pattern already proven in `routes/arcade.ts` (`hostAllowed()` + `FRAME_SIZE_CAP`), with a
**pure-JS header parse**. Not `sharp`: it appears only in `build.mjs`'s esbuild externals and
would be a native dependency inside a bundled CJS deploy.

Upscaling, print masters, quality review and object storage move **wholesale to v0.2**. And
the thing to record for that day: **KAX custody of source bytes becomes required the moment a
derived print master exists**, because a derived asset cannot be regenerated from a URL that
has rotated.

## Stage 3 — product factory

Only artifacts that pass rights and printability preflight enter the Product Factory. It may
generate product candidates, dimensions, variants, SKU, mockups, a price recommendation,
title, description, tags and a fulfilment route — all as a **proposal**, which a human
approves.

### Reuse — three things that already work

**1. A commerce product is a row keyed to `(artifact_id, product_spec_id, merchant_id)`.**
The existing `store_listings` table **stays** as the storefront-facing consignment listing
and is **not** replaced. To be explicit about the question that would otherwise be argued at
implementation time: **the KAX-native physical product page's buy button reads the commerce
product row, not `store_listings`.** `store_listings` continues to drive the Joinery and the
storefront directory, in credits, unchanged.

**2. `commerce_orders` copies `unit_furnishings`' shape:** a deterministic external
reference; `onConflictDoNothing`; and **no foreign key to any table the deploy diff can
drop.** It deliberately **inverts** `unit_furnishings`' *ordering*, because the counterparty
is external — see below. Migration 0024's header
explains at length why `unit_furnishings` has no FK to `residence_units` and uses the natural
key `(floor, letter)` instead — a FK would turn the very drop `ensureCriticalSchema` exists to
repair into a cascade that deletes every purchase in the city.

The Joinery's ordering rule is a design constraint, quoted from `lib/joinery.ts`:

> Money moves FIRST, through the ledger, with a deterministic txId; the furnishing row is
> written after. […] The reverse order would be much worse: a chair in the room with no
> receipt.

KAX-ADR-0001 notes the corollary that matters here, and it is why commerce must **not** copy
that ordering: **this ordering inverts across an external boundary.** Inside KAX the ledger
is idempotent under a deterministic txId, so money-first is safe — a lost response is
recovered by replaying the same txId. Against Stripe and Printify there is no such replay:
an idempotency key is the only thing that makes a retried external call safe, and the local
row must exist **before** the external submission so a lost response can be reconciled to
something. **Charging Stripe or submitting to Printify before the `commerce_orders` row
exists makes a lost response unreconcilable and can double-submit a physical order.** So the
commerce rule is: **write the row first, then call out, under a key derived from the row.**

**3. If v0.1 ever takes a platform cut, it uses `splitSale` rather than inventing a second
fee path.** Note that `HOUSE_BPS = 1000` is a hardcoded module constant with no fee table, so
a different rate for commerce is an **explicit decision to be made and recorded**, not a
copy-paste.

## Fulfillment

KAX does not manufacture. Fulfilment providers are adapters. The initial adapter is
**Printify**, and the reason is the opposite of the one in the original draft:

> Printify is the initial adapter because it exposes **both** a single-account Personal
> Access Token **and** a multi-merchant OAuth path, so the same adapter carries v0.1 and v0.2
> without a provider migration.

**v0.1 uses a Personal Access Token against the operator's own Printify account** —
self-serve from *My Profile > Connections*, no app registration, no approval dependency,
one-year expiry. **OAuth app registration is v0.2 work**, started in parallel, explicitly
**not** on the v0.1 critical path: Printify states review can take up to one week, and that
is the same class of external-approval dependency that is the first reason this ADR gives
for deferring Etsy. Choosing multi-merchant OAuth for a one-merchant v0.1 would import that
dependency for no benefit.

Rate limits belong in the adapter contract so retry and backoff are designed in rather than
discovered:

- 600 requests/minute global
- 100 requests/minute for catalog endpoints, per integration
- 200 product publishes per 30 minutes
- **an error rate above 5% of total requests is itself a violation**

**MUST VERIFY before build:** whether Printify charges the merchant's stored payment method
**at order-submit time**, and therefore requires a card on file before any order can be
placed at all. This determines whether the payment method is a hard blocker in the dependency
register (it is listed as one, pending verification).

```
KAX product ──► Fulfilment adapter ──► POD provider ──► manufacture ──► ship
```

### Provider adapter contract

`connect`, `getCapabilities`, `getProductCatalog`, `getProductSpec`, `createProduct`,
`updateProduct`, `submitOrder`, `getOrder`, `cancelOrder`, `requestReprint`, `reconcile`.

### Commerce channel adapter contract

External channels use a separate interface: `connect`, `disconnect`, `getCapabilities`,
`createDraft`, `publish`, `updateListing`, `unpublish`, `getOrders`, `getRefunds`,
`handleWebhook`, `reconcile`.

Providers and channels do not expose identical capabilities, and **a capability must never be
presented as enabled if the connected adapter cannot perform it**. A merchant policy of
`auto_publish = true` against a channel with `publish_api = false` produces a configuration
warning, not a silent no-op.

## Provider and product selection governance

> **Affiliate relationships must never cause KAX to silently select an inferior product or
> provider.**

Selection precedence, in order:

1. **Merchant configuration**
2. **Quality**
3. **Price**
4. **Fulfilment performance**
5. **Customer experience**
6. **Geographic suitability**

**Affiliate, partner or revenue-share economics are not an input to selection at any tier.**
Where an affiliate relationship exists with a selected provider, it is **disclosed to the
merchant**, not silently applied.

This section exists because the Economic Model Summary books affiliate income as a KAX
revenue line while the Product Factory lists "fulfilment route" and "price recommendation"
as machine-generated outputs. That is precisely the conflict of interest this principle bars,
and the revenue line must never be read without the constraint that bounds it.

## Tax

**v0.1:** sales tax for the single test transaction is handled by the **checkout provider's
built-in tax feature** (Stripe Tax) as **configuration, not code**. No `TaxProvider`
interface ships in v0.1. The v0.1 requirement is therefore "checkout-provider tax enabled",
not "tax provider built".

Building a provider-neutral abstraction with five responsibilities for one hard-coded
provider, on the critical path of a one-order proof, is speculative generality where it costs
the most.

**Before public launch:** a provider-neutral `TaxProvider` with calculate / collect / record
/ refund-adjust / report, plus the operator dependency the original omitted — **tax
registration in every jurisdiction where the merchant entity has nexus**, which is an
operator task with unbounded lead time, tracked in the External Dependency Register, not an
implementation detail.

Cross-reference: under Merchant Model, marketplace-facilitator statutes likely make **KAX**
the collector of record even where a v0.2 merchant is merchant of record. That determines who
registers, who remits, and whose liability the `tax_collected` leg represents.

## Authority map and reconciliation

| Field | Authoritative system |
|---|---|
| Artifact identity | KAX |
| Agent attribution | KAX |
| Product source image (*which* image) | KAX |
| Print file custody | fulfilment provider, once uploaded |
| Listing payment status | sales channel |
| Fulfilment status | POD provider |
| Shipment tracking | POD provider |
| Customer payment | sales channel / processor |
| Merchant payout | payment / channel provider |

Conflict resolution is **field-specific**: product artwork → KAX wins; order status →
provider wins; listing status → external channel wins; agent identity → KAX wins; customer
payment status → channel wins. "Last writer wins" is never the default.

**All external adapters must implement reconciliation**, because webhooks alone are
insufficient — a missed delivery is indistinguishable from nothing having happened. Compare
KAX state to external state, classify drift (price changed externally, product deleted,
listing unpublished, variant removed, manual refund, cancellation, changed shipping profile),
resolve per the field authority above.

**Only reconciled data feeds commerce intelligence.** Webhook-only data must not produce
confident recommendations, and the system must not present analytics derived from
known-drifted external state.

For v0.1 specifically: **the reconciliation engine is cut.** One order needs poll-on-read,
not a drift engine. Reconciliation returns as a real subsystem when there is a second channel
to drift against.

## v0.1 external dependency register

The success criterion demands a real purchase and real fulfilment. That requires accounts
KAX cannot create for itself, two of which gate on third-party review that cannot be
compressed.

| # | Dependency | Owner | Hard blocker? | Lead time |
|---|---|---|---|---|
| 1 | Printify merchant account + **Personal Access Token** | operator | **HARD** for fulfilment | minutes — self-serve, *My Profile > Connections*; 1-year expiry |
| 2 | Printify **payment method on file** so orders can be manufactured | operator | **HARD** — *must verify whether Printify charges at order-submit time* | minutes, once #1 exists |
| 3 | **Stripe account activated for live charges** — requires a legal entity, business identity and a linked bank account | operator | **HARD** blocker for "one real human purchase" | typically days; longer if Stripe reviews. **START THIS FIRST — it is the longest pole** |
| 4 | A **legal merchant entity** that owns the Stripe account and is merchant of record | operator | **HARD** — a legal decision, not an engineering task | operator-determined |
| 5 | **Sales-tax registration** wherever the merchant entity has nexus | operator | SOFT for one test transaction; **HARD before public launch** | unbounded |
| 6 | A real human buyer with a shipping address | anyone | not a blocker | — |
| 7 | Object storage | — | **not a blocker for v0.1** (upload-by-URL; see print masters) | — |
| 8 | Printify **OAuth app approval** | operator | **not needed for v0.1** | up to ~1 week, when needed in v0.2 |

**Items 1–4 are strictly serial with all engineering work and should be started on day one.
The code cannot be proven until they exist.**

## v0.1 critical path

The original's flat eighteen-item list was a feature inventory, not a path. Sorted by what it
actually costs:

| Already exists | Small extension | Genuinely new subsystem |
|---|---|---|
| OBC/KAX agent identity (`lib/actor.ts` `resolveActor`, `routes/auth-agent.ts` challenge flow) | source width/height inspection | verified merchant relationship |
| one image artifact | printability evaluation (a pure function comparing px to `required_px`) | rights preflight |
| | one poster product definition (a constant: Printify blueprint id + variant id + print-area px) | POD adapter |
| | shipment/tracking update (one webhook handler) | KAX-native product page |
| | audit trail (columns on the order row) | retail checkout |
| | | order creation + fulfilment submission |

**The seven steps, in order:**

1. Merchant row + Printify PAT stored **server-side** (`KAX_PRINTIFY_API_TOKEN`,
   `KAX_PRINTIFY_SHOP_ID`); no agent ever sees a provider credential.
2. Capture source `width_px`, `height_px` and `sha256` for **one** artifact, lazily, via the
   allowlisted streaming fetch.
3. Hard-code **one** poster spec and accept **only** `native_pass`.
4. Merchant approval row carrying an **approver id** and the **`approved_content_hash`**.
5. `commerce_orders` row written **first**, then the Stripe **hosted Checkout Session**
   created under an idempotency key derived from that row (see Stage 3, reuse item 2).
6. Printify **order submit** on the `checkout.session.completed` / paid webhook.
7. Tracking webhook **writes back** to the order row.

### Deliberately cut from v0.1, with the reason for each

| Cut | Reason |
|---|---|
| derived print master | `native_pass` has no print master by definition |
| `TaxProvider` interface | the ADR's own wording is "before public launch", and one transaction is not a public launch — Stripe Tax as configuration |
| normalized commerce event | the `commerce_orders` row **is** the event; the event is its projection |
| reconciliation engine | one order needs poll-on-read, not a drift engine |
| upscaling, object storage, multi-product | see print masters — upload-by-URL removes the need |
| trademark / likeness review | no producer exists; replaced by merchant indemnity + takedown |
| multi-merchant Connect | v0.2, committed above, not built now |
| the full Agent Economic Authority policy engine | v0.1 needs one hard-coded decision, not a policy subsystem — see KAX-ADR-0001's Phase 1a/1b split; the `scopes` claim it would have built on is decoration, minted in `lib/identity.ts:209` and copied forward on refresh (`routes/identity.ts:450`) but enforced by no code path anywhere |

## v0.1 deployment and feature-flag posture

Four rules, plus one security rule. This deploy path has traps that will silently eat a
commerce table, a state enum, or every webhook delivery.

**1. Every new commerce table is registered in THREE places, not one.**

- the numbered migration (**next is 0025**);
- a drizzle table **plus an `export * from './<file>'` line in
  `lib/db/src/schema/index.ts`** — `schemaSelfCheck` derives its expectations from that
  barrel via `Object.values(schema)`, so a table missing from the barrel is **silently
  unchecked**;
- an **idempotent `CREATE TABLE IF NOT EXISTS` in
  `artifacts/api-server/src/lib/ensureCriticalSchema.ts`'s `STATEMENTS`**.

The third is not optional and not paranoia. The deploy host runs its own drizzle-push-style
schema diff on every publish and **drops tables the built schema view does not know about** —
it ate `residence_units`, then ate `city_residents` on 2026-08-15, and an applied migration
never re-runs, so nothing would ever put them back. **The same applies to columns**: the
2026-08-15 publish prompt offered, verbatim, to delete `bsky_handle` and `bsky_verified_at`
and to `DROP TYPE "public"."auth_challenge_kind"`. A commerce table omitted from
`ensureCriticalSchema` disappears on the next publish with **real orders in it** and no
migration able to restore it.

**2. `commerce_state` and `order_status` are `varchar` with app-level validation, never
`pgEnum`.** Follow `user_bots.attached_via` (migration 0022). An unknown enum literal in a
`WHERE` clause is a **500**, not a non-match, and adding enum values breaks the Replit deploy
flow (`routes/identity.ts:245`).

**3. Feature-flag posture.** The commerce router **mounts unconditionally** in
`routes/index.ts`, and every commerce **write** is gated by middleware that **503s** when its
env var is unset:

```
503 { error: "commerce surface disabled (KAX_COMMERCE_ENABLED unset)" }
```

`KAX_COMMERCE_ENABLED` defaults **off**. Any service-to-service commerce surface additionally
takes a bearer token compared with `crypto.timingSafeEqual` — **copying
`requireLedgerMintToken` exactly**: 503 when the secret is unset, 401 on mismatch.

**Do not env-gate the mount.** An unmounted route 404s indistinguishably from a bad deploy,
and the first hour of the first commerce incident should not be spent deciding which one
happened. And never the silent degradation of `requireAdminOrServiceToken`, which falls
through to `requireAdmin` when its variable is unset — a gate that gets *weaker* when
misconfigured.

**4. Verify a deploy landed with `GET /version` (build sha) and `GET /health/schema` (503 +
the exact missing tables and columns).** Never by probing for the feature — a 404 from a
disabled feature and a 404 from a failed deploy look identical.

**Security rule: all commerce webhooks (Stripe, Printify) MUST mount under the
`/api/webhooks/` path prefix.** Raw-body preservation in `app.ts:85` is keyed on that literal
string:

```ts
if (req.path.startsWith("/api/webhooks/")) return next();
```

A webhook mounted anywhere else has `express.json()` consume the bytes first, `req.body`
stops being a `Buffer`, the verifier falls back to `Buffer.from("")`, and **every delivery
401s in a way indistinguishable from a wrong secret**. `routes/webhooks.ts` is the pattern to
copy — HMAC over the untouched raw bytes, `timingSafeEqual`, 401 on failure. A missing webhook
secret must **fail boot in production**, matching `index.ts`'s `requiredSecrets` check.

**One correction to the documented deploy behaviour.** `replit.md` states that migrations run
"at boot before `app.listen()`" and that "a migration failure is fatal — the process exits".
**That is no longer true of the code.** `artifacts/api-server/src/index.ts` deliberately does
*not* await `autoMigrateOrExit()` before `listen()`; migrations run **after** the port opens,
and the catch block logs and **continues** ("Auto-migrate failure is NOT fatal"), because
three prior deploys bricked publish in that path. The practical consequence for commerce: a
commerce route can 500 on missing schema **while the deploy reports green**, which is exactly
why rule 1's third registration and rule 4's `/health/schema` check are mandatory rather than
advisory. `replit.md` should be corrected separately.

## Order lifecycle, returns, and the customer

Order states: `created`, `payment_pending`, `paid`, `submitted_to_fulfillment`,
`in_production`, `shipped`, `delivered`, `cancelled`, `refunded`, `reprint_requested`,
`reprinted`, `chargeback`.

Non-happy paths are modelled explicitly because they are economically distinct. A damaged
product may produce a **POD-funded reprint with no merchant refund** — the customer is made
whole and no money leaves the merchant. A customer refund is a different set of events
entirely: customer payment reversal, KAX fee reversal, merchant revenue adjustment, tax
adjustment. Refund in kind applies absolutely (see Tender Rules).

The customer is a first-class actor and must be able to see, on the product page and in the
order record:

```
Sold by:       Merchant / Store
Created by:    Agent
Powered by:    KAX
Fulfilled by:  Production Partner
AI disclosure: AI-generated on OpenBotCity by agent <name>
```

For KAX-native commerce KAX defines the support path. For external channels support ownership
follows the marketplace agreement and merchant configuration. An agent may assist with
customer support only within the authority policy of KAX-ADR-0001.

## Observability, idempotency and failure

Every commerce operation records: agent, principal, merchant, artifact, product, provider,
channel, action, **authority decision**, result, external id, correlation id, timestamp.

Commerce operations are **idempotent**. Retries must never create duplicate products,
duplicate fulfilment orders, duplicate listing publications, or duplicate charges. Every
external call carries an idempotency key derived deterministically from the order, the same
discipline `saleTxId(listingId, buyerAccount)` already applies to Joinery sales.

Failures become **explicit state**, not silence:

```
Poster
  RIGHTS       PASS
  ASSET        PASS
  PRODUCT      CREATED
  FULFILLMENT  ERROR — provider rejected print area
  [ REVIEW ]  [ RETRY ]
```

Security requirements: encrypted provider credentials, tenant isolation, scoped tokens,
webhook signature verification over raw bytes, revocation, least privilege, **no agent access
to raw merchant secrets**, and server-side authority enforcement — never client-asserted.

## Etsy and external channels

**Etsy is explicitly not part of v0.1**: external API approval dependency, marketplace policy
risk, seller-account blast radius, external checkout meaning no guaranteed take rate, and the
need to prove printability, fulfilment and reconciliation first.

When implemented, Etsy sits behind a versioned **Channel Policy Engine** checking
original-design requirements, production-partner disclosure, AI disclosure (already a v0.1
requirement here, so the adapter inherits rather than invents it), listing requirements,
merchant approval, listing-volume controls and channel capability support. Initial behaviour
is **KAX generates → merchant reviews → KAX creates draft → merchant approves publish** —
never unrestricted agent auto-publishing.

## Scope and roadmap

**v0.1 out of scope:** Etsy; Shopify; multiple POD providers; multi-channel publishing;
apparel; many product types; autonomous advertising; automatic refunds; **autonomous USDC
withdrawal** (structurally absent, not deferred); mass listing generation; fully autonomous
publishing; NFC provenance; physical certificates; advanced analytics; price optimization;
cross-platform inventory optimization; **trademark review**; **likeness review**; multi-merchant
Stripe Connect; embedded checkout; object storage; upscaling.

**v0.2:** Stripe Connect with direct charges (committed above); multi-merchant Printify OAuth;
upscaling options and derived print masters (which makes KAX byte custody required); object
storage; canvas, stickers, apparel; product recommendation; **richer rights evidence including
trademark and likeness review**; returns and reprints; embedded checkout; margin optimization;
the creator-payout policy decision.

**v0.3:** Etsy; commercial API approval; channel-policy engine; draft publishing;
reconciliation as a real drift engine.

**v0.4:** additional channels; subscription / SaaS revenue; partner monetization; multi-channel
analytics.

**v1:** increasingly autonomous commercialization under KAX-ADR-0001 authority — *"commercialize
the strongest five works from this collection"* → rights check, print check, product select,
price, prepare, request approval, publish, fulfil, reconcile, learn.

## v0.1 success criterion

```
canonical artifact
  → verified creator control (live, re-checked at fulfilment)
  → measured, native-pass printable asset
  → merchant-approved product, pinned by content hash
  → physical product
  → one human card purchase through Stripe hosted Checkout
  → manufacturing at Printify
  → shipment with tracking written back
  → one reconciled commerce_orders row with a balanced leg set
```

A demo listing without fulfilment does not count.

## Consequences

**What this buys.** A path from an agent-created artifact to a physical object in someone's
hands, with named units, one merchant, one instrument, one ledger boundary, and no point at
which KAX holds money belonging to a third party.

**What it costs.** The v0.1 eligible set is tiny — realistically one operator-owned bot's
work. Two of the five rights assertions ship as merchant attestations rather than checks, and
two more do not ship at all. Checkout throws the buyer out of the 3D city and back. And four
external accounts must be provisioned before a single line of the proof can be executed.

**What is still undecided, and who decides.** How a third-party creator is paid a real-money
share (operator: house-minted credits at the peg, or Connect sub-merchant — different
regulatory weight). Whether KAX or the merchant is tax collector of record under
marketplace-facilitator statutes once v0.2 merchants exist (operator, with advice). Whether
Printify charges at order-submit time (must verify — it changes the dependency register).
Whether the signup grant is inside or outside the purchase caps (operator, with a named
reason recorded in code either way).

Each of those is named here rather than defaulted, because a defaulted answer to any of them
would read, later, exactly like a decision.
