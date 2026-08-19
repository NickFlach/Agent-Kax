# KAX-ADR-0002 — Commerce Gateway: canonical artifacts into the physical economy

- Status: Proposed (2026-08-15)
- Date: 2026-08-15
- Depends on: KAX-ADR-0001 (Agent Economic Authority) — every consequential commerce action **records an immutable authority decision** under that ADR; the full policy engine is a **v0.2** dependency (KAX-ADR-0001 Phase 1b), not a v0.1 one, and this ADR defines **no** permission model of its own; kannaka-memory ADR-0041 (Resonance Futures — identity tokens, double-entry hash-chained credit ledger, floor ledger)
- Related: NickFlach/Agent-Kax issue #181 (operator decisions, locked 2026-08-13); NickFlach/Agent-Kax **issue #269** (`store_listings.price` read as credits by the Joinery and as USD by Stripe checkout — a **blocking precondition** of this ADR, see "What has already shipped"); the Joinery (`lib/joinery.ts`, `lib/joinery-core.ts`) as the existing buy-a-thing-with-credits primitive; `store_listings` as the existing consignment listing
- Code of record today: `artifacts/api-server/src/lib/ledger-core.ts`, `artifacts/api-server/src/lib/ledger.ts`, `artifacts/api-server/src/lib/joinery-core.ts`, `artifacts/api-server/src/lib/joinery.ts`, `artifacts/api-server/src/lib/visibility.ts`, `artifacts/api-server/src/lib/ensureCriticalSchema.ts`, `artifacts/api-server/src/routes/webhooks.ts`, `artifacts/api-server/src/routes/ledger.ts`, `artifacts/api-server/src/routes/identity.ts`, `lib/db/src/schema/artifacts.ts`, `lib/db/src/schema/store-listings.ts`, `lib/db/migrations/0013_credit_ledger.sql`, `lib/db/migrations/0024_unit_furnishings.sql`
- Commerce code of record, shipped to `main` while this ADR was being written: `artifacts/api-server/src/lib/stripeClient.ts`, `artifacts/api-server/src/routes/store-checkout.ts`, the Stripe leg of `artifacts/api-server/src/routes/webhooks.ts` (`:132-173`), `lib/db/src/schema/listing-orders.ts`, `lib/db/migrations/0025_stripe_listing_orders.sql`, the `initStripe` startup step (`artifacts/api-server/src/index.ts:245-267`), and `.agents/memory/kax-commerce-gating.md`

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

Three things are true about the repository today and all three shape everything below.

The ledger write surface **is armed in production**. An unauthenticated `POST /api/ledger/grant`
and `POST /api/ledger/trade` both return 401, not 503, which means `KAX_LEDGER_MINT_TOKEN`
and `KAX_LEDGER_TRADE_TOKEN` are set on the deploy. There is no dead money path and no
incident to clean up; the surface works and is gated.

And KAX has already shipped a unit-label defect of exactly the kind this ADR must not
repeat. `splitSale()` in `lib/joinery-core.ts` takes `price` as a **bigint of minor units**;
`lib/joinery.ts` posts `-split.price` straight into the ledger. But `lib/joinery.ts:174`
tells the user "price must be a positive whole number of **credits**", and
`routes/mcp.ts:292` advertises "whole **credits**, up to `MAX_LIST_PRICE`". A piece listed
at 1000 debits 0.001 credits. `MAX_LIST_PRICE = 1_000_000`, presented to agents as
"1,000,000 credits", is one credit. Conservation holds — `splitSale` asserts it, the ledger
enforces sum-to-zero, no value is lost or created — but every human-facing string in the
Joinery is wrong by a factor of 10^6. That is the concrete precedent for the first section
of this document: **a number without a named unit is not a number.**

And the third: **a Stripe checkout already exists.** It was shipped to `main` while this
document was being drafted, and this ADR is written against a repository that contains it.
The section immediately below records what it is, because an ADR that described a greenfield
here would send an implementer to rebuild working code — and, worse, would leave the defect
that same code introduced unrecorded.

## What has already shipped: the digital-listing checkout

The first leg of commerce is not a proposal. It is on `main`, and it is the surface the rest
of this document extends rather than replaces.

**What it does.** `artifacts/api-server/src/routes/store-checkout.ts` mounts three routes,
unconditionally, from `routes/index.ts:62`:

- `POST /store/listings/:id/checkout` (`:62`) — resolves a `store_listings` row joined to its
  artifact, lazily creates a Stripe **Product** and **Price** for that listing on first
  purchase (`:96` and `:114`) under deterministic idempotency keys
  (`kax-listing-product-<id>`, `kax-listing-price-<id>-<cents>`) so concurrent first
  purchases converge on the same Stripe objects instead of racing, remembers the two ids on
  the listing row (`store_listings.stripe_product_id` / `stripe_price_id`, migration 0025
  `:9-10`), creates a **hosted Stripe Checkout Session** (`:129`), and writes one
  `listing_orders` row keyed on the session id with `onConflictDoNothing` (`:140-150`).
  A stored Stripe price is reused only while it still matches the listing's amount and is
  active; otherwise a fresh Price is created, because Stripe prices are immutable (`:107-119`).
- `GET /store/orders/confirm` (`:159`) — the success page's read/repair path.
- `GET /store/my-orders` (`:193`) — the buyer's own purchases.

Settlement is **webhook-driven**, not confirm-driven: the Stripe leg of `routes/webhooks.ts`
(`:132-173`) verifies the signature through `stripe-replit-sync`, then on
`checkout.session.completed` with `payment_status === "paid"` sets
`listing_orders.status = 'paid'` for that session id (`:156-163`). A buyer who closes the tab
and never returns to the success page still gets a paid order. `GET /store/orders/confirm`
re-reads the session from Stripe and repairs the row if it is behind (`:177-187`); it is a
read/repair path and never the primary settlement route.

**What gates it.** `commerceEnabled()` (`lib/stripeClient.ts:10-13`) is true only when
`KAX_COMMERCE_ENABLED` is exactly `"1"` or `"true"`. With it unset, the whole `/store`
surface 404s from a router-level middleware (`store-checkout.ts:16-20`), the Stripe webhook
404s (`webhooks.ts:134-137`), and the `initStripe` startup step logs and returns without
touching Stripe (`index.ts:247-250`). With it **on**, the `/store` gate additionally **fails
closed with 503** until a probe read against `listing_orders` succeeds
(`store-checkout.ts:21-32`), so flipping the flag on a DB that never received migration 0025
refuses cleanly instead of 500ing mid-checkout. That fail-closed-until-migrated posture is
exactly the discipline the deployment section below argues for, and it is adopted, not
restated.

**Where credentials come from.** `getStripeCredentials()` (`lib/stripeClient.ts:20-70`)
**short-circuits on the secret key.** If `STRIPE_SECRET_KEY` is set, the function returns
immediately with whatever `STRIPE_WEBHOOK_SECRET` happens to hold and the Replit Stripe
connector is never queried at all (`:26-28`, `if (envKey) { return { secretKey: envKey,
webhookSecret: envWebhookSecret }; }`). The connector supplies the webhook secret in exactly
one case: when the secret key also came from the connector (`:68`, `envWebhookSecret ??
settings.webhook_secret`). The source comment at `:21-23` describes the resolution as
per-field, and the one mix it names — connector-supplied secret key plus a dashboard-created
`STRIPE_WEBHOOK_SECRET` — is indeed the mix that works; the reverse is not.

That asymmetry deserves stating flatly, because it fails silently and it fails at the leg that
settles money. **An env `STRIPE_SECRET_KEY` with the webhook secret left to the connector
yields a `StripeSync` constructed with `stripeWebhookSecret: ""` (`:98`), so every webhook
delivery fails signature verification** — and since settlement is webhook-driven, no order ever
reaches `paid`. If the key comes from env, the webhook secret must come from env too. Neither
`getUncachableStripeClient()` (`:76`) nor `getStripeSync()` (`:85`) caches, deliberately, so a
rotated key is picked up on the next call rather than at the next deploy. A set
`STRIPE_WEBHOOK_SECRET` also tells startup that a dashboard-created webhook is in charge, and
suppresses creation of a managed one (`index.ts:256-259`).

**What it does NOT do.** This list is the reason the rest of this ADR still has work in it,
and every item is an absence in the code, not an oversight in the description:

- **No physical product.** It sells the artifact behind a `store_listings` row. There is no
  product spec, no size, no variant, no SKU, no `required_px`, no print area.
- **No fulfilment.** Nothing is submitted anywhere. There is no Printify adapter, no
  `submitOrder`, no shipping address collected, and no tracking write-back. `paid` is the
  terminal state of `listing_orders`; its status vocabulary is three values —
  `pending | paid | canceled` (migration 0025 `:22`).
- **No rights preflight.** No `creator_control` check, no `generation_terms` attestation, no
  lineage, no revocation re-check. The checkout requires only `requireAuth` — any signed-in
  user may buy any priced listing. The one check it does apply is on the *magnitude*: `:85`
  refuses with 400 when the computed `amountCents` is below Stripe's $0.50 floor, or when
  `listing.price * 100` is not a whole number of cents, so a price with more than two decimals
  cannot be quietly rounded onto a card. That guard constrains the size of the number, not the
  currency it is denominated in — it is not a unit check, and it does nothing to separate the
  two readings of `price` recorded immediately below.
- **No printability preflight.** Nothing measures the asset. `artifact_print_assets` does not
  exist; no width, height, format, byte size or sha256 is recorded anywhere.
- **No merchant entity.** There is no merchant row, no merchant of record field, no payout
  destination, no KYB verdict, and no indemnity attestation. The Stripe account is whichever
  one the credentials point at.
- **No tax handling.** No Stripe Tax configuration in code, no `tax_collected`, no
  jurisdiction, no collector-of-record field.
- **No cost of goods and no leg set.** `listing_orders` records `amount_cents` and nothing
  else about the money: no `processor_fee`, no `platform_fee`, no `merchant_net`, no
  `fulfillment_cost`. Margin cannot be derived from the row, and the sum-to-zero settlement
  identity of "The commerce event" below has nothing to be computed against.
- **No AI disclosure** on the product page or in the order record.

So what shipped is a **digital-listing checkout**: real money, real Stripe, real order rows,
for a thing that is already a row in KAX. Every remaining section of this ADR is about the
distance between that and a physical object in the post.

### The blocking defect: issue #269

The shipped checkout introduced, and this ADR must record, precisely the failure its own
units rule exists to prevent. `store_listings.price` is a single `real` (float4) column,
declared with no unit in its name in migration 0011 (`"price" real`, `:7`) and typed
`price: real("price")` in `lib/db/src/schema/store-listings.ts`. It is now read **two
incompatible ways, with nothing separating them**:

| Site | Reads it as | A stored `1000` means |
|---|---|---|
| `lib/joinery.ts:406` — `Math.round(listing.price ?? 0)`, passed to `splitSale(BigInt(price), …)` at `:481`, whose postings are debited verbatim by the ledger | **ledger minor units of play_credit** | 0.001 play_credit |
| `routes/store-checkout.ts:84` — `Math.round(listing.price * 100)`, used as the Stripe Price `unit_amount` at `:115` | **USD dollars** (multiplied by 100 into the Stripe `unit_amount` / `listing_orders.amount_cents`) | $1,000.00 |

The divergence has to be stated in one named unit, because naming the unit is the entire
point. For a stored `1000`: the Joinery debits **1,000 ledger minor units**, which is 0.001
play_credit, while Stripe charges **$1,000.00**, which at this ADR's peg is 100,000 credits —
**10^11 minor units**. The two readings of one column are a factor of 10^8 apart. The tempting
shorthand, "they differ by 10^6, which is exactly `MINOR_UNITS_PER_CREDIT`", holds only if one
credit is treated as one dollar, and that implicit conversion is the very thing this section
forbids. What the two defects genuinely share is a cause, not a magnitude: the same unnamed
10^6 column factor from the Joinery precedent above, here compounded by the 100:1 peg, now
with a card on the other end of it.

Nothing structural keeps the two apart. `purchase()` refuses a listing whose artifact is not
furniture (`lib/joinery.ts:403`), but the checkout's selection is
`.where(eq(storeListingsTable.id, id))` and nothing else (`store-checkout.ts:69`) — **no
artifact-kind filter, no listing-kind column to filter on.** The `:85` amount guard does not
stand in the way either: `list()` requires a positive whole number (`lib/joinery.ts:171`, guard
at `:173`),
so every Joinery price is a clean two-decimal USD amount of at least $1.00 and clears the
$0.50 floor. Every Joinery furniture listing priced in credits is therefore reachable at the
fiat checkout, where it quotes as dollars. A chair listed at 1,000 credits — which the Joinery
posts as 0.001 play_credit — is a $1,000.00 Stripe Checkout Session.

It has not fired only because `KAX_COMMERCE_ENABLED` is unset, and the operator is actively
provisioning Stripe. So this ADR states it as a hard precondition rather than as a risk:

> **`KAX_COMMERCE_ENABLED` must not be set to `1` in any environment that shares a database
> with the Joinery until #269 is closed.** This is a precondition of the v0.1 critical path,
> ahead of every engineering item on it.

Two candidate fixes, and the ADR prefers the second:

1. **A structural filter on what the checkout may sell.** The checkout's query gains a
   predicate restricting it to listings that are unambiguously fiat-priced — the cheapest
   version being the same `artifactType !== "furniture"` refusal `purchase()` already makes,
   the more durable version being an explicit `tender` or `listing_kind` column on
   `store_listings` that says which world the number lives in. This closes the reachability
   but leaves one float column meaning two things, which will be misread again by the next
   reader.
2. **Split the column: `price_minor` (ledger minor units of play_credit, `bigint`) and
   `price_cents` (integer USD cents).** This is the honest fix, because these are genuinely
   different quantities in different currencies and always were. It makes the two readings
   impossible to confuse, it puts the unit in the name as the rule below demands, it removes
   the float from a money path, and a listing that is priced in neither world simply has both
   columns null. It costs a migration, a backfill of the existing `price` values into
   `price_minor` (they are credits today — every existing writer is the Joinery), and touching
   the four `Math.round` display sites in `lib/joinery.ts`.

Either fix must land with a **behavioural test against the real Postgres CI service** — not a
source-string test — asserting that a furniture listing cannot produce a Checkout Session.
The reason is in the ADR's own warning about `lib/publicRouteGating.test.ts`: a test that
greps a route file passes on a rename and on a predicate that is constructed but never
applied.

## What the assets actually measure

Every earlier draft of this ADR had to reason about printability in the abstract, because
nothing in the repository has ever read a KAX asset's bytes. That question is now answered by
measurement rather than by argument, and the answer changes what v0.1 sells.

Six artifacts were fetched from `GET /api/storefront/featured` on `kax.ninja-portal.com` and
their image headers read directly.

**Every one of them is exactly 1024 × 1024.**

There is no larger original to reach for, and this is the part that closes the question rather
than merely narrowing it. `publicUrl` and `thumbnailUrl` on those rows are the **same URL**,
byte-identical — the one checked returned a content-length of 333,111 on both — and the
Supabase bucket in the path is literally named **`artifacts-small`**. Substituting `artifacts`
for that path segment returns **HTTP 400**: there is no large bucket, and no
higher-resolution original anywhere. The bytes live on OpenBotCity's Supabase
(`kfzxdetopeikrvschdwc.supabase.co`), not on KAX storage, so KAX cannot regenerate them at
source either. Six artifacts is a sample; the absent bucket is not. The six establish that
1024 × 1024 is what KAX actually gets, and `artifacts-small` establishes that there is nothing
better to get — for any artifact, checked or unchecked. That is the ceiling, and it is the
claim the product decision below rests on.

Against that, the print specification — read from Printify's own catalogue rather than
assumed. Blueprint **282** with print provider **99**, the poster line, is 300 PPI at every
variant:

| Poster size | Required print file |
|---|---|
| 9 × 11 in | 2700 × 3300 |
| 11 × 14 in | 3300 × 4200 |
| 12 × 18 in | 3600 × 5400 |
| 16 × 20 in | 4800 × 6000 |
| 18 × 24 in | 5400 × 7200 |
| 20 × 30 in | 6000 × 9000 |
| 24 × 36 in | 7200 × 10800 |

The **smallest poster Printify sells** needs 2700 × 3300. A 1024 × 1024 source is **2.6×
short on width and 3.2× short on height**. Every other size is worse. The conclusion is forced
by this ADR's own rule, not chosen against it:

> **v0.1 accepts only `native_pass` products, and no poster can be `native_pass` from a
> 1024 × 1024 source.** A 12 × 12 poster was never a hard v0.1 product; it was an unreachable
> one, and the earlier draft could not know that because nobody had measured.

So v0.1 sells a **sticker** — the largest physical object the measured corpus can fill at the
provider's own stated print area, with no upscaler, no derived asset and no quality review in
the path.

One further thing the byte read turned up, recorded here as a **pre-upload check rather than a
blocker**: the bytes parse as **JPEG** while the filenames end `.png` and Supabase serves them
with `content-type: image/png`. Nothing in the v0.1 path breaks on that — Printify is handed a
URL and decodes it itself — but it is precisely why `artifact_print_assets.format` is specified
under Stage 2 as *decoded from the bytes*, never taken from the extension or the
`Content-Type`. A divergence between the declared container and the actual one is worth
surfacing to the merchant before an upload, not discovering as a provider rejection after a
card has been charged.

### The v0.1 product spec — measured, with real ids

Sticker print areas were read the same way, per `(blueprint, print_provider, variant)`:

| Blueprint | Provider | Size → required print file |
|---|---|---|
| **384** "Square Stickers" | 1 | 2×2 in → 559 × 559 · 3×3 in → 832 × 832 · 4×4 in → 1113 × 1113 · 6×6 in → 1664 × 1664 |
| **400** "Kiss-Cut Stickers" | 99 (Printify Choice) | 2×2 in → 559 × 559 · 3×3 in → 832 × 832 · 4×4 in → 1113 × 1113 · 6×6 in → 1664 × 1664 |
| **476** "Square Vinyl Stickers" | 73 | 2×2 in → 600 × 600 · 3.5×3.5 in → 900 × 900 · 5×5 in → 1500 × 1500 · 8×8 in → 2400 × 2400 · 15×15 in → 4500 × 4500 |

**The PPI is not uniform, and that is the most useful fact in the table.** 559 px across 2 in
is ~280 PPI; 832 px across 3 in is ~277 PPI; 900 px across 3.5 in is ~257 PPI; 600 px across
2 in is exactly 300 PPI. Four densities across three blueprints, on sizes that look
interchangeable from the outside. This vindicates the rule Stage 2 already carries and is the
reason it is restated there: required pixels are read from `placeholders[].width` and
`placeholders[].height` for the specific triple, and never derived from inches × an assumed
DPI.

What a 1024 × 1024 source clears natively: **2×2 in and 3×3 in** on blueprints 384 and 400;
**2×2 in and 3.5×3.5 in** on blueprint 476.

What it does not clear, said out loud so no reader has to wonder why the obvious size is
missing: **4×4 in needs 1113 px and the source has 1024 — 8% short.** That is out of reach,
and only just. Eight percent is exactly the kind of gap a hurried implementer rounds away;
this ADR does not round, because the rounding would be invisible in the product spec and
visible only on the printed object.

- **Recommended — the largest native fit.** 3.5 × 3.5 in **Square Vinyl Sticker**, blueprint
  **476**, print provider **73**, variant **65212**: 900 × 900 required against 1024 × 1024
  available, **~14% linear headroom**. It is the biggest physical object a native-pass v0.1
  can put in the post.
- **Runner-up.** 3 × 3 in **Kiss-Cut Sticker**, blueprint **400**, print provider **99**
  (Printify Choice), variant **45750**: 832 × 832 required, **~23% linear headroom**. Smaller
  object, more margin against the spec, and a print provider Printify itself routes.

**The choice between them is the operator's**, not this ADR's — it turns on unit cost, provider
performance and what a buyer would rather own, all of which are inputs the Provider and Product
Selection Governance section already assigns to the merchant rather than to the machine. What
this ADR fixes is the *shape* of the answer: exactly one spec, native pass only.

And whichever is picked, **the print-area pixels are read from the provider API for that exact
`(blueprint, print_provider, variant)` and stored on the product spec** — at build time, and
re-checked before the first submission. Not copied from the table above on faith, and not
computed from inches. The table above is evidence that the numbers were once measured, not a
substitute for measuring them.

## Decision

KAX will build the **Commerce Gateway**: a provider-neutral extension of the canonical
artifact system that connects artifacts to KAX-native products, physical products,
print-on-demand fulfilment and — later — external marketplaces. Etsy, Printify and Stripe
are adapters, never the canonical commerce model.

v0.1 will prove exactly one thesis end to end and nothing more:

> One authorized agent causes one verified artifact to become one real physical sticker,
> bought by one real human with a card, manufactured and shipped by one real production
> provider, and recorded in one reconciled order row.

The object is a sticker rather than a poster because the section above measured the corpus and
found no poster reachable; the shape of the criterion is unchanged, and deliberately so. One
agent, one verified artifact, one real physical object, one human purchase, one shipment, one
reconciled record — the thesis was never about the object being large.

A demo listing without fulfilment does not count. **Neither does the shipped digital-listing
checkout**, which takes a card for a row in KAX and stops there — the thesis is about matter,
and every clause after "physical sticker" is still to be built.

## Units, and the names money goes by

**1 USDC = 100 play_credit = 100,000,000 ledger minor units — i.e. `MINOR_UNITS_PER_CREDIT
= 1_000_000` and `CREDITS_PER_USDC = 100`.** The peg is set once and never changed
(operator decision 3).

Those two must exist as named exported constants in
`artifacts/api-server/src/lib/ledger-core.ts` — the pure, DB-free module that already holds
`GENESIS_HASH`, `HOUSE_ACCOUNT` and `MAX_POSTINGS_PER_TX` — and be pinned by a unit test
that fails if either value moves.

**They do not exist on `main`, and they do not exist on the branch this ADR is committed to.**
`lib/ledger-core.ts` here is 145 lines long and carries those three constants and nothing else.
A foundation slice that adds `MINOR_UNITS_PER_CREDIT`, `CREDITS_PER_USDC` and
`MINOR_UNITS_PER_USDC` (`lib/ledger-core.ts:30-34`) with a pinning test in
`lib/ledger-core.test.ts` is written, but it sits on the unmerged branch
`fix/ledger-units-topology-revocation`. Until that branch lands, an implementer must treat the
constants as work to do, not as an import that resolves. On `main` the 10^6 factor exists only
as an unnamed literal in two places (`routes/identity.ts:29`, `SIGNUP_GRANT_MINOR =
100_000_000n`, and `routes/ledger.ts:315`, `Number(bal) / 1_000_000` for display), and the
100:1 ratio appears nowhere in code at all. Both of those sites must be re-expressed in terms
of the named constants, so that the peg has exactly one definition a test can hold down.

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
sites in `lib/joinery.ts` — the catalog (`:128`), `worksForSale` (`:320`), `listingsOfAgent`
(`:346`) and **`purchase()` (`:406`)**. The last is the one that matters: a float is rounded
into the number the ledger then posts.

The original draft of this ADR added, here, "**Commerce adds no rounding site of its own** —
commerce money is integer cents end to end and never crosses `store_listings.price`." **That
sentence is now false**, and it was falsified by the checkout that shipped while this
document was being written: `routes/store-checkout.ts:84` is a fifth rounding site,
`Math.round(listing.price * 100)`, and it reads the very column the Joinery reads as ledger
minor units. This is issue #269, recorded above as a blocking precondition. The rule survives
the correction — it is the right rule, and the shipped code is what has to move — so it is
restated in the only form that is enforceable:

> **Commerce money is integer USD cents end to end, and no commerce path may read
> `store_listings.price` while that column can also mean ledger minor units.** Either the
> column is split so its name carries its unit (`price_minor` / `price_cents`), or commerce is
> structurally prevented from selecting a credit-priced listing. Until one of those is true,
> the commerce surface stays flagged off.

The generalisation worth carrying forward, because it is the second time the same defect has
appeared in this repository: a unit ambiguity costs nothing while only one reader exists, and
becomes an incident the moment a second reader quotes the number in a real currency. The
Joinery's 10^6 error was harmless for as long as the ledger was the only consumer. It stopped
being harmless the day a Stripe Price was built from the same column.

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
departs from its literal reading. `lib/joinery.ts:485-505` posts buyer `trader:*` → seller
`trader:*` plus a maker royalty to a *third* `trader:*`. The boundary that makes that
legitimate is the **goods-purchase-with-a-platform-fee carve-out** named below; stated
precisely, decision 5's rule is *no bare value transfer between two principals* — a
prediction-market settlement or a goods purchase under the carve-out is not one. Restating
decision 5 unqualified would make this ADR false on the day it is written.

These are not defaults and they are not scope lines. A scope line can be un-scoped by a
sprint; a deny-by-default capability implies an operator may grant it. So KAX-ADR-0001
**removes** `credits.transfer`, `usdc.withdraw`, `fiat.withdraw`, `merchant.payout.change`
and `merchant.bank.change` from its capability enumeration entirely rather than listing them
as denied, and the enforcement belongs in `validatePostings` in `lib/ledger-core.ts`, as a
per-`kind` permitted-account-topology rule. KAX-ADR-0001 prints the table, and it is
reproduced here rather than paraphrased, because a paraphrase that collapsed the three Joinery
kinds into one row would be weaker than the rule itself — `joinery_fee` may credit only the
house and may debit nobody, and `joinery_royalty` may credit only a trader and may debit
nobody; those legs are paid *out of* the buyer's `joinery` debit, never on their own:

| kind | may debit | may credit |
| --- | --- | --- |
| `grant` | `house` | `trader:*` |
| `escrow` | `house` | `amm:*` |
| `trade` | `trader:*`, `amm:*` | `trader:*`, `amm:*` |
| `payout` | `amm:*` | `trader:*`, `house` |
| `joinery` | `trader:*` | `trader:*` |
| `joinery_fee` | — | `house` |
| `joinery_royalty` | — | `trader:*` |

A kind absent from the table is refused outright, and so is an account that parses to class
`unknown`, because a typo'd account would otherwise become a permanent balance no principal can
spend from. On top of the table sits the whole-transaction refusal: a transaction that debits a
trader and credits the house **without crediting any trader** throws. The test that holds this
down is `lib/ledger-core.test.ts` ("permitted posting topology: what it refuses"), not
`lib/ledger.test.ts` — it belongs in the pure core's own suite because the core, not the
routes, is where the rule lives.

**None of that is on `main`, and none of it is on this branch.** As it stands here,
`validatePostings` (`lib/ledger-core.ts:64-79`) checks posting count, bigint amounts, a
non-empty `account` and `kind` on every posting, a non-empty `asset` argument, and `sum === 0n`
— and nothing about *which accounts* may face each other under *which kind*. It would accept a
redemption without complaint. The implementation of the table above (`accountClass` at `:143`,
`PERMITTED_TOPOLOGY` at `:178`, `assertPermittedTopology` at `:204`, called from
`validatePostings` at `:320`) exists on the unmerged branch
`fix/ledger-units-topology-revocation` and nowhere else. KAX-ADR-0001 records these two items
as landed; on this branch they are not, and the honest reading is that they are written and
awaiting merge. Until they merge, every invariant in this section is protected by nothing — and
an invariant protected by nothing is one endpoint away from being off.

The carve-out that keeps the shipped Joinery inside decision 5, stated identically to
KAX-ADR-0001, with its boundary drawn where the code can actually hold it:

> **Goods purchase with a platform fee** is a defined carve-out from the no-transfer rule.
> Three conditions, all required, and only the first is enforceable at the ledger core — and
> then only partly:
>
> 1. **The movement happens under a named sale `kind`, and paying the house is never the
>    whole transaction.** There is no generic `transfer` kind and there cannot be one: a kind
>    absent from `PERMITTED_TOPOLOGY` is refused outright, so the only `trader:* ->
>    trader:*` shape the core will accept is `joinery`. The redemption test keys on the house
>    being **credited without any trader being credited**, not on a fee posting being
>    present — see the cheap-sale hole below for why, and for what that costs.
> 2. **The counterparty is not caller-chosen as a free field** — seller and maker accounts
>    are derived server-side from a listing row, inside `purchase()` (`lib/joinery.ts:381`
>    onward: the listing join at `:397`, the maker resolution and the
>    `SellerCannotBePaid` refusal at `:478`, all before any posting is built), never read out of the
>    request body. Contrast `routes/ledger.ts`, where `principal` *is* a request string.
> 3. **A good is delivered.** The ledger core **cannot see this**. `validatePostings` is
>    pure and DB-free; it has no row to look at. This clause is an **obligation on the
>    caller**, discharged by writing the delivery row in the same logical operation
>    (`unit_furnishings` for the Joinery, the `commerce_orders` row for Commerce), and this
>    ADR says so rather than pretending the core checks it.

The earlier draft of this ADR claimed the core refuses "a bare `trader:* -> trader:*` posting
carrying no fee posting under a `*_fee` kind". It does not, and the difference is not
pedantic. Clause 1 is a *kind* rule, not a *fee-presence* rule, and KAX-ADR-0001 names the
hole that follows from that: with `HOUSE_BPS = 1000` (10%, `lib/joinery-core.ts:25`) and
integer division, a sale priced below 10 minor units computes a house cut of zero, and
`lib/joinery.ts:508` filters zero postings out. Such a sale posts `trader -> trader` under
kind `joinery` with **no fee posting at all**, and the topology check accepts it —
deliberately, because keying the redemption test on the *presence* of a house leg would refuse
a legitimate cheap sale. The fix is a floor, not a stricter core check: **a minimum sale price
such that the computed house fee is at least 1 minor unit**, which is a Phase 1a item in
KAX-ADR-0001 and is not yet in code. Both documents state that one boundary; neither states a
second.

And, as the section above records, on this branch the core enforces none of it: `PERMITTED_TOPOLOGY`
and `assertPermittedTopology` live on `fix/ledger-units-topology-revocation`, unmerged. Routes
are added by people in a hurry and the core is not, which is the whole reason the rule belongs
there — but a rule that has not merged is not yet protecting anything. Delivery is enforced one
layer up regardless, by the caller, and is auditable only because the delivery row and the
postings share a deterministic reference.

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

The code already assumes exactly this shape and nothing more: `getStripeCredentials()` resolves
one secret key and constructs one `Stripe` client with no `stripeAccount` option and no
`on_behalf_of`, and `checkout.sessions.create` passes no `application_fee_amount` and no
`transfer_data` (`store-checkout.ts:129-138`). There is no Connect topology latent in the
shipped code waiting to be switched on — which is the correct v0.1 state, and worth recording
so nobody reads the presence of a Stripe integration as the presence of a marketplace.

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
validation, never a `pgEnum`.** `routes/identity.ts:221` states the reason in the source —
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
is needed client-side. **This is shipped** — `routes/store-checkout.ts:129`,
`stripe.checkout.sessions.create({ mode: "payment", … })` — so the physical checkout extends a
working hosted-Checkout call rather than introducing one.

Being honest about the cost: the redirect **breaks immersion**. A buyer standing in KAX's 3D
city is thrown out to a Stripe-hosted page and back. That is accepted for v0.1 because the
alternative — Stripe Embedded Checkout — is more integration surface on the critical path of
a one-transaction proof. Embedded Checkout is a v0.2 polish item and is listed as such.

### Superseded for the physical path (#286)

The in-city checkout design pass replaces hosted Checkout **for physical goods only**. The
buyer saves a card once through a SetupIntent in settings, and the purchase itself is a
server-side confirming PaymentIntent — `confirm: true, use_stripe_sdk: true` — so no
navigation occurs and an SCA challenge is completed inline. `off_session: true` and
`error_on_requires_action` are forbidden on this path: the buyer is present, and either one
converts a recoverable challenge into a decline they cannot clear. Hosted Checkout remains
the digital-listing path in `routes/store-checkout.ts`, unchanged; the two are sibling
routes against sibling tables and are never merged.

**Fulfilment is a manual admin action, not a webhook side effect (#287).** Critical-path step
6 and the sentence "Printify submission hangs off the paid webhook" under "Settlement is
webhook-driven" are superseded with it. `POST /api/admin/commerce-orders/:id/submit` creates
the order at Printify and `POST /api/admin/commerce-orders/:id/release` sends it to
production; both are idempotent no-ops under `SELECT … FOR UPDATE`, and **both refuse
anything whose `status` is not `paid` at the moment of that locked read**. Two steps and not
one, because the window between them is where a human's eyeballs are simultaneously the
address-validation backstop and the fraud check — which is what makes shipping v0.1 without
an address-validation service a decision rather than an omission. The webhook keeps settling
`commerce_orders.status`, `refunded` and `chargeback` included, so an order whose money has
gone back stops being submittable.

> **Corrected (#325 follow-up).** The sentence above originally said `submit` refused an
> unpaid order and said nothing about `release`, and the code matched: `release` checked
> `released_at` and `printify_order_id` and never read `status` at all. That is a hole and
> not an omission in the prose. Submission and production are separated by a hold window
> measured in minutes, `charge.dispute.created` and `charge.refunded` land inside windows
> like that, and "the money has gone back" therefore has to be re-asked at the moment of
> production and not inherited from the moment of submission. `release` now reads `status`
> under its own `FOR UPDATE` and answers `not_paid` — 409 on the admin endpoint, a no-op
> that burns no attempt in the worker. The clause `status = 'paid'` was added to the
> worker's release claim query at the same time, but that one is only an optimiser: the
> locked read is what decides, exactly as on the submit side.

> **Superseded WHEN `KAX_PRINTIFY_AUTO_FULFILL` is on.** The paragraph above stays true of
> every deployment that has not set that flag, which is all of them by default. What it no
> longer says is that manual is the *only* path: `lib/commerceFulfillmentWorker.ts` presses
> the same two buttons on a one-minute timer, and a deployment opts into it per environment.
>
> **Both endpoints remain, unchanged, and remain the default.** Nothing was removed and no
> route changed shape. The worker calls `lib/commerceFulfillment.ts`, which is the two
> handlers' bodies lifted out verbatim — same row lock, same `paid` precondition read under
> it, same `printify_order_id` double-submit guard, same rollback on refusal, same address
> taken from the order's own `ship_to_*` snapshot. There is one implementation and two
> callers, so automation cannot drift away from what an operator pressing the button gets.
>
> **What automation costs, stated rather than waved at.** The manual window between submit
> and release IS the fraud and address-validation backstop, and a timer is not a pair of
> eyes. The flag being off by default is the honest form of that: a deployment keeps the
> backstop unless somebody decides it does not need one.
> `KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS` (default 15 minutes) preserves the *shape* of the
> window — an operator watching `GET /api/admin/commerce-orders` has that long to cancel at
> Printify before anything is manufactured — but a window nobody is required to look at is a
> weaker guarantee than one that cannot advance without a human, and it should be read as
> such. `0` is a valid setting and means no window at all.
>
> **The retry policy is the genuinely new decision.** `printifyClient.ts` never retries a
> write, because a retried submission whose first attempt landed is a second parcel. The
> worker earns each retry: **429 backs off exponentially** — 2, 4, 8, 16 and 32 minutes
> between six attempts, so 62 minutes of retrying in total — and **every other 4xx parks
> immediately**, because a rejected address is rejected again tomorrow. A **transport
> failure parks too**: status 0 usually means the network is gone, in which case nothing
> this process can do will resolve the order faster than a human will. Parking sets
> `fulfillment_attempts` to the ceiling, which every claim query filters on — the order
> leaves the worker's hands for good and waits for the manual endpoints, which still work on
> it. Migration 0028 adds the four columns this needs; `fulfillment_last_error` holds the
> provider's status and code, or one of a small set of fixed literals, and **never a
> response body**, because Printify's 4xx bodies quote the offending field back and on this
> path that field is the buyer's street.
>
> **Corrected (#325 follow-up): 5xx is not a retryable failure, it is an unknown.** The
> paragraph above originally grouped 5xx with 429 and called a transport failure "the one
> case where we cannot know whether the order was created". Both halves were wrong, and the
> second was wrong in the expensive direction. A 5xx can just as easily come from a backend
> that created the order and then failed to answer; and a **2xx carrying no order id** —
> which `printifyClient.ts` raised as a 502 and the worker therefore read as a retryable
> server error — is worse than unknown, because the request was accepted and the order
> almost certainly EXISTS. Retrying either one posts a second order against one customer
> payment: a second parcel, and a second charge to the merchant's own card.
>
> So ambiguity is now a first-class outcome and never a retry.
> `PrintifyAmbiguousSubmissionError` is the signal for "the provider may have created this
> order and we cannot name it", the no-id path raises it, and it can never satisfy
> `isRetryable`. Before the worker would resubmit a paid order that still has no
> `printify_order_id` and whose last marker is ambiguous, it calls
> `findOrderByExternalId(client_reference)` — which is what `external_id` has been carrying
> the order's `client_reference` FOR since the first version of this design, and which
> nothing could read back until now. Found means adopt the id, mark the row submitted, charge
> no attempt and post nothing. Definitively absent — a completed search that reached the end
> of the list — means a resubmission creates one parcel rather than a second one. A search
> that FAILED, including one that ran out of its page budget, resolves nothing: it charges an
> attempt, keeps the ambiguous marker and looks again next tick, because "we could not look"
> must never be read as "it is not there".
>
> The release pass is deliberately untouched by this. `sendToProduction` is called with an id
> already on the row, so it cannot raise the ambiguous error, and re-sending an order that is
> already in production manufactures nothing extra. Ambiguity is a property of naming the
> order, and release begins by knowing the name.
>
> **`GET /api/admin/commerce-orders`** is added with it, because a retry ladder readable only
> in logs is one nobody can answer "did that order ship?" about. It is `requireAdmin`, and it
> does **not** carry the `ship_to_*` columns — the address leaves this server exactly once,
> addressed to the printer, and a listing page finding it convenient is not a second reason.
>
> **Corrected again (#327): the guard above was written against an API that does not
> exist, and inferred absence from three things that are not one.** A live response was
> captured from `GET /v1/shops/{id}/orders.json` and checked against the code. Four
> corrections follow, and each of them turned a guard against a duplicate parcel into a
> cause of one.
>
> 1. **There is no top-level `external_id` in a Printify order.** Not in the list
>    projection and not in `GET /orders/{id}.json`. The keys a listed order carries are
>    `id, app_order_id, shop_id, address_to, line_items, metadata, total_price,
>    total_shipping, total_tax, status, shipping_method, created_at,
>    sent_to_production_at, fulfilment_type, printify_connect, sales_channel_type_id`. The
>    value we POST as `external_id` comes back inside `metadata`, as `shop_order_label`.
>    `findOrderByExternalId` read `row.external_id`, which is `undefined` on every row: no
>    page ever matched, the scan ran to the declared last page, and the function answered
>    `null` — "definitively absent" — to the one caller whose next step was to post the
>    order again. It now matches `metadata.shop_order_label`, with the top-level field kept
>    as a fallback in case a plan or an API version ever populates it. Every fixture was
>    rebuilt from the captured shape, because fixtures that invented the field are what let
>    the bug pass a test suite.
> 2. **A page that could not be parsed is not an empty page.** `Array.isArray(obj.data) ?
>    obj.data : []` turned a bare array, an unexpected envelope, or a 200 with `{}` into a
>    page with no entries, which the pager read as the end of the list and reported as
>    absence. It also contradicted the adapter's own reading of the same value: an empty
>    `{}` from the submission POST raises the ambiguous error — "we cannot tell, do not
>    resubmit" — while the same `{}` from the GET meant "certainly not there, resubmit".
>    Absence is now concluded only from positive evidence of a well-formed page: `data` an
>    array and `current_page`, `last_page` and `total` all present as numbers. Anything else
>    throws, consistent with the interface's own contract that a search which could not be
>    completed throws rather than answering.
> 3. **Reconciliation runs before EVERY submission, not only before an ambiguous-looking
>    one.** The marker is written after the POST returns, so the failures it exists for — a
>    crash inside the POST window, an OOM, a pod replaced by a rolling deploy, a database
>    blip — are precisely the failures that stop it being written. What is left behind is a
>    row that looks untried: null id, zero attempts, null error. The guard was keyed on the
>    one piece of state the failure it guards against destroys. A durable pre-POST intent
>    write would close it too, but it costs a transaction on every submission to record
>    something one GET can settle, and it would still have to be reconciled against Printify
>    to be acted on. Reconciling unconditionally is cheaper, is one path instead of two, and
>    closes the marker-overwrite hole in the same motion — a marker later replaced or
>    cleared can no longer hide an existing order, because nothing consults it to decide
>    whether to look. The cost is one GET per submission against a 600/minute ceiling, on a
>    shop that submits a handful of orders a day; the cost of a failed lookup is that
>    nothing is submitted until it succeeds, which is the safe direction.
> 4. **`POST /admin/commerce-orders/:id/submit` reconciles too.** That endpoint is where an
>    order the worker could not resolve is ROUTED to a human, and it posted blind: no
>    lookup, no look at the marker. The most likely place in the system to print a second
>    parcel was the button pressed by the one person who had been told the order needed
>    attention. It now runs the same reconcile — adopting an order Printify already has and
>    reporting `reconciled: true` — and answers **409 `reconcile_unavailable`** when the
>    lookup could not be completed AND the row says a submission may already exist, which
>    `{"acknowledgeDuplicateRisk": true}` overrides for an operator who has just checked
>    Printify's own UI. A failed lookup on a row with nothing in doubt is deliberately NOT a
>    409: the manual route is the only path to a fulfilled order proven in production, and
>    refusing there would take it away every time Printify's list endpoint was unwell. The
>    reconcile is also skipped entirely for an order that is not paid, not there, or already
>    submitted — those refuse without a provider call, and spending a lookup to reach the
>    same refusal would put outbound traffic on paths that had none.
>
> **On search depth: the claim that the order list is newest-first is an ASSUMPTION and has
> not been verified.** The captured envelope carries `current_page` and `last_page` and
> documents no sort order, and nothing in the code or the tests establishes one. It is
> recorded as an assumption rather than a fact because the code is written so that being
> wrong about it is slow rather than dangerous: the page budget bounds a pathological loop,
> exhausting it throws, and absence is only ever concluded from the declared last page. Do
> not narrow the budget on the strength of the ordering claim until somebody has checked it.
>
> **Adjacent, found while fixing the above:** `ensureCriticalSchema.ts` re-seeded the sticker
> at `item_cents = 1564`, which is 0026's figure and not 0027's. An applied migration never
> re-runs, so a rebuilt `commerce_products` would have come back carrying the double-counted
> total 0027 exists to remove — $20.73 for a sticker priced at $15.64 — on the quietest
> possible path, a table repair nobody watched. The seed now carries 1055 + 509 and the
> variant id, and the schema test asserts the migrated state rather than the remembered one.

**The purchase endpoints are deliberately off the OpenAPI contract, and the settings
endpoints are deliberately on it.** This is a recorded split rather than an accident of
which file was edited first.

`POST /api/me/purchasing/*` (#284) are ordinary request/response settings writes that return
the same derived object `GET /me` returns. They belong on `lib/api-spec/openapi.yaml`, they
get orval-generated hooks, and the generated client is a net win.

`POST /api/commerce/quote`, `POST /api/commerce/purchase` and `GET /api/commerce/orders/:ref`
(#286) are not. They are one hand-rolled protocol: a five-minute signed quote, a
`clientReference` the client mints **before** it calls and reuses across every retry, a
retry that must return a prior charge's state rather than making a new one, and a poll target
for the case where the client never learned whether its own request succeeded. orval's
generated mutation hooks model a call as a fresh attempt each time; every property above is
about a call that is *not* fresh. Generating them would produce a client that has to be
fought at each step, and a contract that describes the shape of the request while saying
nothing about the only part that matters. So this trio stays off the contract until the
protocol stops being hand-rolled — and if it is ever put on, the `clientReference` semantics
go in the description, not just the schema.

Environment names. The first three are **shipped and read by `lib/stripeClient.ts`**; the
Printify pair was still to be introduced when this table was written and is now read by
`lib/printifyClient.ts`, with the two automation flags below it read per tick by
`lib/commerceFulfillmentWorker.ts`. The per-row Status column is the authority. Use exactly
these:

| Name | Purpose | Status | v0.1 |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | server-side Stripe API | **shipped** — `stripeClient.ts:24` | required |
| `STRIPE_WEBHOOK_SECRET` | verify `/api/webhooks/stripe` | **shipped** — `stripeClient.ts:25` | required only on the dashboard-webhook path; the connector-managed webhook supplies its own — see "v0.1 deployment and feature-flag posture". Required whenever `STRIPE_SECRET_KEY` is set in env |
| `KAX_COMMERCE_ENABLED` | feature flag, **default off** | **shipped** — `stripeClient.ts:10-13`, accepts `"1"` or `"true"` | required to write |
| `KAX_PRINTIFY_API_TOKEN` | Printify Personal Access Token | **credential exists and is verified** against the live API (subject 28170669, expires 2027-08-16, scopes sufficient); the code that reads it is to build | required |
| `KAX_PRINTIFY_SHOP_ID` | which Printify shop to publish into | **value known and verified: `28604869`** ("KAX", `sales_channel: "custom_integration"`, created 2026-08-16, order approval set to manual). The code that reads it is to build. **Never hard-code the Shopify shop 28599902, and never default to the first shop listed** | required |
| `KAX_COMMERCE_QUOTE_SECRET` | HMAC key for the five-minute quote token (#286) | shipped — `routes/commerce.ts` | **required on more than one instance.** Unset, each process signs with a per-process random key: roughly half of all Buy presses then land on an instance that did not mint the quote, `readQuote` returns null, and a legitimate purchase dies at `quote_invalid`. The fallback logs one warning naming this variable; provision it rather than discovering it |
| `KAX_COMMERCE_DAILY_ORDER_CAP` | purchases per rolling 24 h before `cap_reached` (#286) | shipped — `lib/purchasingState.ts` | optional, defaults to 5. Anything that is not a positive integer falls back to the default rather than disabling the cap — a typo in a limit must not become "no limit" |
| `KAX_PRINTIFY_AUTO_FULFILL` | drive submit/release on a timer instead of by hand, **default off** | shipped — `lib/commerceFulfillmentWorker.ts`, accepts `"1"` or `"true"`, parsed exactly as `printifyEnabled()` parses its own | optional. Both this AND `KAX_PRINTIFY_ENABLED` must be on or the worker is inert. Off means the manual admin endpoints are the only fulfilment path, which is the v0.1 decision and the default |
| `KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS` | how long an automatically submitted order waits before it is sent to production | shipped — `lib/commerceFulfillmentWorker.ts` | optional, defaults to `900000` (15 min). **`0` is a valid setting** meaning no hold at all, and is deliberately distinguished from absent — a `Number(v) \|\| DEFAULT` read would silently turn it back into 15 minutes. Non-numeric or negative falls back to the default, because a typo in a safety window must not shorten it |

**Credential resolution is the shipped one and is not re-specified here.** The precedence —
an explicit `STRIPE_SECRET_KEY` short-circuits the connector entirely, so the webhook secret
must come from env alongside it; the connector supplies a webhook secret only when it supplied
the key too — plus the deliberate non-caching of the client, is defined in
`getStripeCredentials()` (`lib/stripeClient.ts:20-70`) and described under "What has already
shipped". Physical commerce calls `getUncachableStripeClient()` and inherits it, including that
trap. Do not add a second credential path; a rotated key must be picked up in one place, not
two.

### Redirect base URL — the shipped implementation must change

Success and cancel redirects reuse an **existing** base-URL variable. No new base-URL
variable is invented, and **the base is never taken from request headers**.

The shipped `webBaseUrl()` (`routes/store-checkout.ts:54-60`) **violates that rule**, and the
rule wins. It reads `req.get("origin")` first, falls back to the first entry of
`REPLIT_DOMAINS`, and falls back again to `req.protocol` plus the `Host` header. Two of those
three sources are attacker-supplied request headers. An attacker who can set `Origin` on the
checkout POST chooses the host the buyer is returned to **after a real card charge**, with a
`session_id` in the query string — which is an open redirect on the one request in the system
where the user is most primed to trust where they land. It must be replaced before
`KAX_COMMERCE_ENABLED` is set, and it is listed as a precondition alongside #269.

Be specific about *which* existing variable, because the repo has two and they are not
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

Note that `REPLIT_DOMAINS` is already what the startup step uses to register the managed
Stripe webhook (`index.ts:262-264`), so a single env-derived base serves both and there is no
new variable to provision.

### Settlement is webhook-driven

The Stripe webhook endpoint is **`/api/webhooks/stripe`** — shipped at `routes/webhooks.ts:132`,
matching the existing `/api/webhooks/openbotcity` convention. The path prefix is load-bearing,
not cosmetic — see Deployment posture.

The settlement shape is likewise decided in code and adopted here rather than re-proposed:
**the webhook is the settlement path and the confirm endpoint is a read/repair path.** The
`checkout.session.completed` handler moves the order to `paid` (`webhooks.ts:156-163`);
`GET /store/orders/confirm` re-reads the session and repairs a stale row on refresh
(`store-checkout.ts:177-187`). Physical orders follow the same discipline for the same reason:
a buyer who closes the tab after paying must still get a fulfilled order, so no state
transition may depend on the browser coming back. The corollary for fulfilment is in the
critical path below — **Printify submission hangs off the paid webhook, never off the success
page.**

> **Superseded for the physical path (#286, #287).** The sentence immediately above is the
> digital rule and no longer describes physical fulfilment. Printify submission is a **manual
> admin action** — `POST /api/admin/commerce-orders/:id/submit`, gated on `status = 'paid'`
> read under `SELECT … FOR UPDATE` — and not a webhook side effect. The manual window IS the
> fraud and address-validation backstop, which is what makes shipping v0.1 without an
> address-validation service a decision rather than an omission. See "Superseded for the
> physical path (#286)" above. The webhook still settles `commerce_orders.status` — including
> `refunded` and `chargeback` off `charge.refunded` / `charge.dispute.*`, which is what stops
> an order whose money has gone back from staying submittable — it just submits nothing.

> **Amended again for deployments that set `KAX_PRINTIFY_AUTO_FULFILL`.** Submission may also
> be driven by `lib/commerceFulfillmentWorker.ts`, a scheduler that presses the two admin
> endpoints' shared implementation on a one-minute timer. The half of the block above being
> amended is the one about a *human* being required — not the one about the *webhook*, which
> stands unchanged and for the same reason. A Stripe delivery that triggers manufacturing
> must be idempotent under the order's key and must fail loudly enough to be redelivered; a
> worker that reads `status = 'paid'` under a row lock on its own clock owes Stripe nothing,
> retries on its own terms, and can be switched off without touching the settlement path.
> That sentence describes **both** of the worker's passes and is the reason the release pass
> was changed to make it true: until the #325 follow-up, `releaseCommerceOrder` never read
> `status`, so the half of the worker that actually spends money on manufacturing was the
> half that was not reading the settlement the webhook writes. Reading it under the lock is
> what lets the worker stay indifferent to Stripe's delivery timing — a dispute that lands
> at any point before production is seen by the next locked read, whenever that is.
> The flag is off by default, both endpoints remain, and a deployment gets the manual path
> unless it says otherwise. See "Superseded WHEN `KAX_PRINTIFY_AUTO_FULFILL` is on" above for
> the retry policy, the release hold window, and what the automation costs.

One thing the shipped webhook does *not* do, and physical commerce must: its settlement block
is wrapped in a `try/catch` that logs and swallows (`webhooks.ts:165-167`), then returns 200.
That is defensible when the only consequence is an order row that the confirm path will repair
on the buyer's next page load. It is **not** defensible once the same event triggers a
manufacturing submission, because a swallowed failure there is a paid order that never ships
and nothing retries. Physical settlement must return non-2xx so Stripe redelivers, with the
work made idempotent under the order's deterministic key.

## Cash flow and custody timeline

One $8 sticker, traced end to end, with every point money is held, by whom, and for how
long. This is the section that decides whether KAX is holding third-party money.

The object is the v0.1 product and the figure is a plausible retail price for it, not a
decision: **this ADR does not set the price**, for the same reason it does not set the
platform-fee rate — that is an operator call, to be made and recorded before the first charge.
What the arithmetic has to do is hang together, so every amount below is the same $8.00 charge
followed through the whole flow rather than a mechanism illustrated with a number from a
different product.

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
      │  $8.00 + shipping + tax, authorized and captured at checkout
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
      the operating entity's own stored payment method, charged
      by Printify at order submission — billing trigger STILL
      UNVERIFIED, see dependency 2                              consumed at T+0

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
      │  $8.00 + shipping + tax, authorized and captured at checkout
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
      at order submission — billing trigger STILL UNVERIFIED,
      see dependency 2                                           consumed at T+0

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
  `HOUSE_BPS = 1000` (10%), a hardcoded module constant at `lib/joinery-core.ts:25` with
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
- `LEDGER_ADVISORY_KEY = 0x1ed6e401` serializes **every** append process-wide. Every physical
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

### `commerce_orders` and `listing_orders` are two tables, deliberately

`listing_orders` now exists (migration 0025, `lib/db/src/schema/listing-orders.ts`) and does
one job well: it ties a Stripe Checkout Session to a listing and a buyer, with Stripe as the
source of truth for payment state. The question an implementer will otherwise have to guess
at is whether physical orders extend it or get their own table. **They get their own table:
`commerce_orders`. `listing_orders` is not extended, not renamed, and not duplicated.**

The justification is in what `listing_orders` actually stores. It has nine columns —
`id`, `listing_id`, `buyer_user_id`, `stripe_session_id`, `amount_cents`, `currency`,
`status`, and the two timestamps — and three of them are the reasons:

- **`listing_id INTEGER NOT NULL REFERENCES store_listings(id) ON DELETE CASCADE`**
  (migration 0025 `:17`). A physical order must not be keyed on `store_listings` at all. It is
  keyed on `(artifact_id, product_spec_id, merchant_id)` — the commerce product row — because
  the same artifact is a different product as a 12 × 18 poster than as a sticker, and
  `store_listings` has no notion of a product spec. And the cascade is disqualifying on its
  own: this ADR's rule, argued at length under Stage 3, is **no FK to a table the deploy diff
  can drop**, because the Replit publish step has already eaten `residence_units` and
  `city_residents`. A row that records a real card charge and a manufacturing submission may
  not vanish because a listing row did.
- **`amount_cents INTEGER` is the whole money model.** The physical order's money is the
  balanced leg set of "The commerce event" — `item_price`, `shipping_charged`,
  `tax_collected`, `processor_fee`, `platform_fee`, `merchant_net`, plus the out-of-band
  `fulfillment_cost` and `fulfillment_shipping_cost`, each with its bearer and its settlement
  ref. Extending `listing_orders` to carry those means roughly fifteen columns that are
  permanently null for every digital row, on a table whose entire virtue is that it is small
  and says only what it knows.
- **`status` has three values** — `pending | paid | canceled` (migration 0025 `:22`). The
  physical lifecycle has twelve, and `paid` is its fourth state rather than its last. Widening
  the digital table's vocabulary would make `listing_orders.status` mean "one of twelve things,
  nine of which cannot happen here", which is how a status column stops being readable.

There is a fourth reason, and it is the sharpest: `listing_orders.listing_id` points into
`store_listings`, whose `price` column is the subject of issue #269. Building the physical
order path on top of that row is building it on top of the unit ambiguity. `commerce_orders`
carries its own `item_price_cents` and never reads `store_listings.price`.

What **is** copied from `listing_orders`, because the shipping session got it right:

- `stripe_session_id TEXT NOT NULL UNIQUE` as the natural idempotency key, with
  `onConflictDoNothing` on that target at insert (`store-checkout.ts:150`) — the same
  deterministic-reference discipline `saleTxId()` applies to Joinery sales.
- **Amount columns that name their unit** (`amount_cents`, not `amount`) and an explicit
  `currency`.
- **`status` as `TEXT`, not a `pgEnum`** — matching this ADR's own hard schema constraint, for
  the Replit deploy reason.
- Webhook-driven settlement with the confirm endpoint as a read/repair path.

The two tables are **never joined and never unioned**. "All my purchases" across both is a
question for a view or an application-level merge, not for a shared table — and that question
does not arise in v0.1, which sells one sticker.

**One registration gap to close, in the shipped table.** This ADR's deployment rule 1 requires
every commerce table in three places. `listing_orders` is in the migration and in the drizzle
barrel (`lib/db/src/schema/index.ts:14`), but there is **no `CREATE TABLE IF NOT EXISTS
listing_orders` in `artifacts/api-server/src/lib/ensureCriticalSchema.ts`** — its `STATEMENTS`
cover `residence_units`, `city_residents`, `user_bots` columns and `unit_furnishings`, and
nothing else. Two of three is exactly the state `residence_units` was in before the deploy
diff dropped it, and an applied migration never re-runs. `listing_orders` will hold real
orders. It must be added to `ensureCriticalSchema`, along with the two
`ALTER TABLE store_listings ADD COLUMN IF NOT EXISTS stripe_*_id` statements, before the flag
is flipped.

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

`{"gross": {"amount": 8, "currency": "USD"}}` is not a record of anything. Eight is neither
the amount charged (tax and shipping are on top) nor the amount kept (fees and manufacturing
come off), so it reconciles to no external report and margin cannot be derived from it. On a
small object the gap is proportionally larger, not smaller: shipping and the fixed part of the
processor fee do not shrink with the sticker.

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
charges the merchant's stored payment method directly — believed to be at order submit, though
that trigger is **still unverified** and is dependency 2 in the register. The exclusion does
not rest on the timing: whenever the charge lands, that money never passes through the Stripe
charge, so it cannot be a leg of a set that balances against `customer_charge`. It is a
separate cash flow, on its own clock — and `paid_at` below is recorded as observed rather than
assumed, which is what will settle the trigger once a real order runs.

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
per-product: the same artifact can be a native pass as a sticker, need upscaling as a 12 × 18
poster, and be flatly unsuitable as a 24 × 24 canvas. A single per-artifact commerce status
would be a lie about two of those three. That is no longer a hypothetical — it is the measured
state of every artifact checked, and the `artifacts-small`-only bucket makes 1024 px a ceiling
for the rest. It is why v0.1's product is the first of the three and not the second.

| From | Event | To |
|---|---|---|
| `not_evaluated` | rights preflight passes | `rights_checked` |
| `not_evaluated` | rights preflight fails | `rights_blocked` |
| `not_evaluated` | rights preflight inconclusive | `review_required` |
| `rights_checked` | asset measured, meets spec | `asset_checked` |
| `rights_checked` | fetch / decode / sentinel / too small | `asset_insufficient` |
| `asset_checked` | product spec satisfied at its `required_px` | `product_eligible` |
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
the asset host.** `public_url` points at OBC's Supabase bucket — measured, and confirmed to be
`kfzxdetopeikrvschdwc.supabase.co`, a host with no KAX credential on it. Those bytes can be
replaced with no KAX-side write, no `updated_at` change, and nothing at all to notice — the
merchant approved a photograph and the sticker prints something else.

One implementation hazard to name, and it is narrower than the original draft claimed. The
revocation gate is `isRevoked` (`lib/revocation.ts:33`), and it is reached from **exactly one
place**: `resolveActor`'s agent-token branch, `lib/actor.ts:98-104`, where a withdrawn
verification raises a 403. `agentForActor` (`lib/actor.ts:157`) does **not** call it — the
owner-session path resolves the agent by id and checks `canMutate` against `agent.ownerId`
(`:174-175`), and nothing on that path consults `revoked_at` at all. Outside `lib/actor.ts`
the only caller is `routes/identity.ts:97`, which reads the state to report it, not to gate on
it.

So the covered surface is "a request presenting an agent token", and nothing else — not the
owner's session, not a background job, not a service-token surface, not a future MCP façade
calling the library directly. **The Commerce Gateway must call the revocation check itself,
at its own library boundary**, so every façade over it gets the gate rather than the single
door that happens to have it today. The shipped checkout illustrates the point exactly: its
only guard is `requireAuth` (`routes/store-checkout.ts:62`), so it consults revocation nowhere.

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
`routes/agent-storefront.ts:333-337` (`agentWorksWhere`) deliberately applies neither,
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
answered **with no new subsystem**: `resolveActor(req)` + `isRevoked` +
**`commerceEligibleWhere()`** — the commerce-eligibility predicate defined once under "v0.1
eligible set" above and in `lib/visibility.ts` — plus **one immutable `authority_decisions`
row per consequential action**. Everything else is DENY, hard-coded, with no policy row at
all.

The gate is emphatically **not** `agentWorksWhere(agent)`
(`routes/agent-storefront.ts:333`), which an earlier draft of this ADR named here. That was
wrong twice over. Wrong on the semantics: `agentWorksWhere` answers *whose storefront does this
piece appear on*, attributing on `agentId` OR `creatorBotId` with no publication gate and no
attachment gate, so it would admit the entire harvested catalogue that the "v0.1 eligible set"
exists to exclude — **storefront appearance is not commercial eligibility.** And wrong on the
mechanics: it is module-private (`function agentWorksWhere(agent: Agent)`, no `export`), so a
`lib/` module cannot call it at all. KAX-ADR-0001's Phase 1a states the same correction in the
same terms.

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
module constants at `lib/joinery-core.ts:25` and `:27`, with no fee table and no per-artifact
terms.
And it has a silent failure mode: when the maker cannot be resolved to an agent with an
`obc_bot_id`, `lib/joinery.ts:504` folds the royalty into the seller's posting, leaving
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
print at 300 PPI needs 7200 pixels. Assuming otherwise ships a blurry print to a paying
customer. That is the lesson, and it is why the gate exists at all.

But notice what the arithmetic quietly assumed: **300 PPI everywhere.** The measured catalogue
says that is false. Across the sticker blueprints read under "What the assets actually
measure", the implied density runs from **~257 PPI** (900 px across 3.5 in, blueprint 476)
through ~277 PPI (832 px across 3 in, blueprint 400) and ~280 PPI (559 px across 2 in) to
**exactly 300 PPI** (600 px across 2 in, blueprint 476) — four densities inside three
blueprints, on sizes that look interchangeable from the outside. Posters happen to be a
uniform 300 PPI at every variant; stickers are not, and nothing tells an implementer which case
they are in except asking the provider.

So the arithmetic above is an explanation of *why* the gate exists and never a way to compute
it. **The required pixels come from `placeholders[].width` and `placeholders[].height` for the
specific `(blueprint, print_provider, variant)`, read from the provider API and stored on the
product spec — never from inches × an assumed DPI.** A spec derived at 300 PPI would demand
1050 px for a 3.5-inch sticker that actually needs 900, and would refuse, as
`asset_insufficient`, the one native pass KAX can serve today. A rule that rejects work KAX
can do is as expensive as one that approves work it cannot.

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
| `format` | decoded from bytes | never from the extension or `Content-Type` — measured OBC assets parse as **JPEG** while named `.png` and served as `image/png` |
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
approve a print the source cannot support. The measurement confirms the first half literally:
on all six artifacts checked, `publicUrl` and `thumbnailUrl` were the same URL and the same
bytes. The rule still stands as written, because it costs nothing when the two agree and it is
the only thing standing between a future divergence and an approved print.

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

**v0.1 accepts only `native_pass` products.** The spec is the one named under "The v0.1
product spec" — a sticker size the source artifact already satisfies at the print area the
provider API reports — and everything else is refused with `asset_insufficient`. No upscaling,
no quality review, no derived asset.

**With a sticker as the v0.1 product, no upscaler is needed at all**, and that is worth stating
as a consequence rather than leaving as an inference. The measurement did not merely rule a
poster out; it removed the only reason v0.1 would have had to build or buy an upscaler in the
first place. Nothing on the v0.1 path depends on a derived print master: the file handed to
Printify is the artifact's own `public_url`, byte for byte, `print_master_id` in the
`approved_content_hash` tuple is null for a native pass, and the sha256 that pins merchant
approval is a hash of the source bytes rather than of anything KAX produced. If any v0.1 step
ever needs a derived asset, it has stopped being a native pass and the answer is to refuse the
product, not to generate the file.

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
> `routes/arcade.ts:45`).

KAX must still read the bytes once, for two things and only two: **width/height**, and a
**sha256** to pin merchant approval. The mechanism is a single **size-capped, https-only,
allowlisted streaming fetch** that computes both and **discards the bytes**, reusing the SSRF
pattern already proven in `routes/arcade.ts` (`hostAllowed()` + `FRAME_SIZE_CAP`), with a
**pure-JS header parse**. Not `sharp`: it appears only in `build.mjs`'s esbuild externals and
would be a native dependency inside a bundled CJS deploy.

Upscaling, print masters, quality review and object storage move **wholesale to v0.2** — where
every earlier draft of this ADR wanted them anyway, but now for a stated reason rather than as
a scope preference. **Upscaling is the v0.2 capability that unlocks the formats the measurement
rules out today.** Posters start at 2700 × 3300 and the corpus tops out at 1024 × 1024; the
4 × 4 in sticker misses by 8%. Every one of those becomes reachable the day a derived print
master exists and not one day earlier, which makes upscaling the single highest-leverage item
in v0.2 rather than a polish task — it is the difference between one sellable format and a
catalogue.

Two obligations come with it on the day it lands, both recordable now. **KAX custody of source
bytes becomes required the moment a derived print master exists**, because a derived asset
cannot be regenerated from a URL that has rotated — and the measurement makes that sharper than
it reads: the source host is OBC's, `artifacts-small` is the only bucket, and there is no
larger original to re-derive from if those bytes change. And an upscaled master is a **new
asset with its own provenance**, so it takes its own row, its own sha256, its own
`source_artifact_id` edge under "Derivative lineage", and a fresh merchant approval — an
approval pinned to the source bytes does not carry to a file KAX generated afterwards.

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
storefront directory, in credits, unchanged — and, once #269 is closed, the shipped digital
checkout too.

**2. `commerce_orders` copies `unit_furnishings`' shape:** a deterministic external
reference; `onConflictDoNothing`; and **no foreign key to any table the deploy diff can
drop.** (That last clause is why the physical order does not extend the shipped
`listing_orders`, whose `listing_id` and `buyer_user_id` are both hard FKs with
`ON DELETE CASCADE` — the full decision is under "`commerce_orders` and `listing_orders` are
two tables, deliberately".) It deliberately **inverts** `unit_furnishings`' *ordering*, because
the counterparty is external — see below. Migration 0024's header
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

### What is verified about the Printify account, and what is not

The token half of this is done and was exercised against the live API, so it is recorded as
fact rather than as a step to take. `Authorization: Bearer <token>` against
`https://api.printify.com/v1/` authenticates as subject **28170669**, expiring **2027-08-16**,
and the granted scopes cover `shops.manage`, `catalog.read`, `orders.read` / `orders.write`,
`products.read` / `products.write`, `webhooks.read` / `webhooks.write`, `uploads.read` /
`uploads.write` and `print_providers.read` — every scope the adapter contract below needs,
including the `uploads.*` pair that upload-by-URL depends on and the `webhooks.*` pair the
tracking write-back depends on. Nothing in the v0.1 path is blocked on a missing permission.

**The shop is resolved.** It was not, when this section was first written: the account held
exactly one shop — id 28599902, "My Shopify Store", `sales_channel: "shopify"` — and that is
the wrong shape for this integration. A Shopify-channel shop exists to push products into a
Shopify storefront; v0.1 sells through KAX's own hosted Checkout and submits orders by API,
which wants a shop whose channel is the API rather than someone else's storefront.

The operator created a dedicated store on 2026-08-16. `GET /v1/shops.json` now returns two,
and the Shopify shop is untouched:

```json
[{"id":28599902,"title":"My Shopify Store","sales_channel":"shopify"},
 {"id":28604869,"title":"KAX","sales_channel":"custom_integration"}]
```

**`KAX_PRINTIFY_SHOP_ID` = `28604869`.** The channel slug `custom_integration` was predicted
from third-party corroboration only — Printify documents the field as read-only and enumerates
no values — and is now observed, so it can be asserted on rather than merely expected. The shop
was confirmed API-addressable in the same session: `products.json`, `orders.json` and
`webhooks.json` each return 200 with an empty collection, so the token operates it and nothing
is registered against it yet. Order approval is set to **manual**, which is the setting the
Stripe sequencing below depends on.

The consequence for the implementer is unchanged and still easy to get wrong: resolve the id
from configuration, refuse to start the fulfilment path without it, and never fall back to
"the first shop the list returns". A silent fallback there publishes KAX's product into a
Shopify store the operator never intended to sell from — and that shop is still in the list,
so the fallback would find it.

Rate limits belong in the adapter contract so retry and backoff are designed in rather than
discovered:

- 600 requests/minute global
- 100 requests/minute for catalog endpoints, per integration
- 200 product publishes per 30 minutes
- **an error rate above 5% of total requests is itself a violation**

**STILL UNVERIFIED:** whether Printify charges the merchant's stored payment method **at
order-submit time**, and therefore requires a card on file before any order can be placed at
all. The token session above did not settle it and could not: no API response states the
billing trigger, and reading it off a live submission would mean submitting a real order. It
needs **one manual order placed through Printify's own UI** to observe when the charge lands.
Until that happens the payment method stays listed as a hard blocker in the dependency
register, because the failure mode of guessing wrong is a paid customer order that cannot be
manufactured.

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
| Product source image (*the bytes*) | KAX, **only once custody is taken** (#264); until then, OBC's bucket holds the only copy |
| Print file custody | fulfilment provider, once uploaded — and KAX, for derived masters (`derived_assets` + the KAX bucket, #264) |
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
| 0 | **Issue #269 closed** — `store_listings.price` no longer readable as both credits and USD | engineering | **HARD — gates the flag, not just the pilot.** Blocks `KAX_COMMERCE_ENABLED=1` in any environment sharing a database with the Joinery | days; a migration plus a behavioural CI test |
| 0b | **`webBaseUrl()` no longer derived from request headers** (`store-checkout.ts:54-60`) | engineering | **HARD — gates the flag.** Post-charge open redirect | hours |
| 0c | **`listing_orders` + the two `store_listings.stripe_*` columns added to `ensureCriticalSchema`** | engineering | **HARD — gates the flag.** Two-of-three registration is how `residence_units` was lost | hours |
| 1 | Printify merchant account + **Personal Access Token** | operator | **SATISFIED** — token verified live against `api.printify.com/v1/`: subject 28170669, expires 2027-08-16, scopes cover `shops.manage`, `catalog.read`, `orders.*`, `products.*`, `webhooks.*`, `uploads.*`, `print_providers.read` | done |
| 1b | **A dedicated Printify store for KAX**, and therefore a value for `KAX_PRINTIFY_SHOP_ID` | operator | **SATISFIED 2026-08-16.** Shop `28604869`, "KAX", `sales_channel: "custom_integration"`, order approval set to manual; verified API-addressable (products/orders/webhooks all 200, all empty). Creation was self-serve as predicted. The Shopify shop 28599902 remains in the list untouched, so the id still **must not be defaulted to the first shop listed** | — |
| 2 | Printify **payment method on file** so orders can be manufactured | operator | **HARD** — *still unverified whether Printify charges at order-submit time*; needs one manual order through Printify's own UI to observe | minutes, once #1b exists |
| 3 | **Stripe account activated for live charges** — requires a legal entity, business identity and a linked bank account | operator | **HARD** blocker for "one real human purchase" | **in progress** — the operator is provisioning Stripe now, which is what makes items 0/0b/0c urgent rather than merely open |
| 4 | A **legal merchant entity** that owns the Stripe account and is merchant of record | operator | **HARD** — a legal decision, not an engineering task | operator-determined |
| 5 | **Sales-tax registration** wherever the merchant entity has nexus | operator | SOFT for one test transaction; **HARD before public launch** | unbounded |
| 6 | A real human buyer with a shipping address | anyone | not a blocker | — |
| 7 | Object storage | — | **not a blocker for v0.1** (upload-by-URL; see print masters) | — |
| 8 | Printify **OAuth app approval** | operator | **not needed for v0.1** | up to ~1 week, when needed in v0.2 |
| 9 | Stripe API credentials reaching the server | operator | **satisfied by shipped code** — `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` or the Replit Stripe connector, resolved by `lib/stripeClient.ts`. **An env secret key short-circuits the connector, so the webhook secret must be set in env alongside it** or every delivery fails verification | — |

**Items 2–4 are strictly serial with all engineering work and should be started on day one.
The code cannot be proven until they exist.** Items 1 and 1b are both off that list now: the
token is real and works, and the dedicated store exists and is API-addressable. Printify is
therefore no longer on the critical path for *access* at all — what remains of it is item 2,
the billing-trigger question, which needs one real order rather than any setup.

**Items 0, 0b and 0c are serial with the operator work in a way the original register did not
anticipate**, because the flag they gate is the same flag item 3's provisioning is heading
toward. They are the only entries whose owner is engineering, and they are the only ones that
can cause harm by being late rather than merely delay the pilot: the day Stripe is live and the
flag goes on with #269 open, every credit-priced furniture listing in the city becomes a fiat
checkout quoting its credit price as dollars — a chair the Joinery debits 1,000 minor units for
(0.001 play_credit) charges a card $1,000.00.

## v0.1 critical path

The original's flat eighteen-item list was a feature inventory, not a path. Sorted by what it
actually costs — and the first column is now substantially larger than when this ADR was
drafted, because the digital-listing checkout shipped:

| Already exists | Small extension | Genuinely new subsystem |
|---|---|---|
| OBC/KAX agent identity (`lib/actor.ts` `resolveActor`, `routes/auth-agent.ts` challenge flow) | source width/height inspection | verified merchant relationship |
| one image artifact | printability evaluation (a pure function comparing px to `required_px`) | rights preflight |
| **Stripe client + credential resolution** (`lib/stripeClient.ts`) | one sticker product definition (a constant: Printify blueprint id + print-provider id + variant id + the print-area px read from `placeholders[]` for that triple) | POD adapter |
| **hosted Checkout Session creation** (`store-checkout.ts:129`) | shipment/tracking update (one webhook handler) | KAX-native **physical** product page |
| **`/api/webhooks/stripe` with signature verification** (`webhooks.ts:132`) | audit trail (columns on the order row) | `commerce_orders` + the balanced leg set |
| **webhook-driven settlement + confirm/repair path** | **redirect base URL** — replace the header-derived `webBaseUrl()` with the `resetLinkBase()` precedence | order creation + fulfilment submission |
| **`KAX_COMMERCE_ENABLED` gate + fail-closed-until-migrated middleware** | lazy Stripe Product/Price creation for a *product spec* rather than a listing | |
| **an order row keyed on the Checkout Session, with a unique idempotency target** | | |

Retail checkout is no longer a subsystem to build. It is a working call to
`stripe.checkout.sessions.create` that has to be pointed at a commerce product row instead of a
`store_listings` row, given a safe redirect base, and taught to collect a shipping address.

**Step 0, before any of the seven: close the preconditions.** #269, the header-derived redirect
base, and the `ensureCriticalSchema` registration gap. Until all three land,
`KAX_COMMERCE_ENABLED` stays unset. This step has no engineering dependency on anything below
it and should be done first for that reason as well as for the safety one.

**The seven steps, in order:**

1. Merchant row + Printify PAT stored **server-side** (`KAX_PRINTIFY_API_TOKEN`, verified;
   `KAX_PRINTIFY_SHOP_ID` = `28604869`, verified — but still resolve it from configuration and
   refuse to start the fulfilment path rather than defaulting it, because the Shopify shop is
   still in the list and a fallback would find it); no agent ever sees a provider credential.
2. Capture source `width_px`, `height_px`, `format` and `sha256` for **one** artifact, lazily,
   via the allowlisted streaming fetch. Expect 1024 × 1024 and JPEG bytes; assert rather than
   assume, because the whole product choice below rests on those two numbers.
3. Hard-code **one** sticker spec — blueprint, print provider, variant, and the print-area
   pixels read from `placeholders[]` for that exact triple — and accept **only**
   `native_pass`. The recommendation and its runner-up, with ids, are under "The v0.1 product
   spec"; the final pick is the operator's.
4. Merchant approval row carrying an **approver id** and the **`approved_content_hash`**.
5. ~~`commerce_orders` row written **first**, then the Stripe **hosted Checkout Session**
   created under an idempotency key derived from that row (see Stage 3, reuse item 2).~~
   **SUPERSEDED for the physical path (#286)** — see "Superseded for the physical path
   (#286)". The row-first ordering stands and is load-bearing; what replaces hosted Checkout
   is a server-side **confirming PaymentIntent** against a card saved earlier through a
   SetupIntent (`confirm: true, use_stripe_sdk: true`, never `off_session`), so the buyer
   never leaves the tab. The idempotency key is derived from the row's `client_reference` — a
   UUID — rather than from its `serial` id, which is unique per database and not per Stripe
   account.
6. ~~Printify **order submit** on the `checkout.session.completed` / paid webhook — extending
   the shipped handler at `webhooks.ts:156-163`.~~ **SUPERSEDED for the physical path
   (#287)** — see "Superseded for the physical path (#286)". Submission is a **manual
   two-step admin action**, `submit` then `release`, each idempotent under
   `SELECT … FOR UPDATE` and **each gated on `status = 'paid'` read under that lock** — the
   second half of that gate arrived in the #325 follow-up; see the correction under
   "Superseded for the physical path (#286)". The manual window between
   them is the fraud and address-validation backstop and is the whole rationale; making it a
   webhook side effect removes it. The webhook keeps settling `commerce_orders.status` —
   `paid` / `payment_failed` off `payment_intent.*`, `refunded` / `chargeback` off
   `charge.refunded` and `charge.dispute.*` — and still returns non-2xx on a failed write so
   Stripe redelivers, rather than swallowing the error as the digital path does.
7. Tracking webhook **writes back** to the order row.

### Deliberately cut from v0.1, with the reason for each

| Cut | Reason |
|---|---|
| derived print master | `native_pass` has no print master by definition — and both candidate v0.1 stickers are native passes (900 × 900 or 832 × 832 required against a measured 1024 × 1024), so whichever the operator picks, nothing on the path wants one |
| `TaxProvider` interface | the ADR's own wording is "before public launch", and one transaction is not a public launch — Stripe Tax as configuration |
| normalized commerce event | the `commerce_orders` row **is** the event; the event is its projection |
| reconciliation engine | one order needs poll-on-read, not a drift engine. Still cut: the #325 follow-up adds `findOrderByExternalId`, which is a lookup of ONE order by the key we submitted it under and is called only where the alternative is posting it twice. It reconciles nothing on a schedule and compares no state |
| upscaling, object storage, multi-product | upload-by-URL removes the need, and a sticker needs no upscale at all; upscaling is what v0.2 buys the larger formats with |
| **posters, and every format above the source's 1024 px** | not deferred by preference — **unreachable**. The smallest poster needs 2700 × 3300 and there is no larger original; 4 × 4 in stickers need 1113 px and miss by 8%. They return with upscaling in v0.2 |
| trademark / likeness review | no producer exists; replaced by merchant indemnity + takedown |
| multi-merchant Connect | v0.2, committed above, not built now |
| the full Agent Economic Authority policy engine | v0.1 needs one hard-coded decision, not a policy subsystem — see KAX-ADR-0001's Phase 1a/1b split; the `scopes` claim it would have built on is decoration, minted in `lib/identity.ts:209` and copied forward on refresh (`routes/identity.ts:407`) but enforced by no code path anywhere |

## v0.1 deployment and feature-flag posture

Four rules, plus one security rule. This deploy path has traps that will silently eat a
commerce table, a state enum, or every webhook delivery.

**1. Every new commerce table is registered in THREE places, not one.**

- the numbered migration (**0025 is taken by `0025_stripe_listing_orders.sql`; next is 0026**);
- a drizzle table **plus an `export * from './<file>'` line in
  `lib/db/src/schema/index.ts`** — `schemaSelfCheck` derives its expectations from that
  barrel via `Object.values(schema)`, so a table missing from the barrel is **silently
  unchecked**;
- an **idempotent `CREATE TABLE IF NOT EXISTS` in
  `artifacts/api-server/src/lib/ensureCriticalSchema.ts`'s `STATEMENTS`**.

**The already-shipped `listing_orders` is currently registered in only two of the three** —
see the registration gap noted under "`commerce_orders` and `listing_orders` are two tables,
deliberately". Closing that is a precondition of enabling commerce, not a follow-up.

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
flow (`routes/identity.ts:221`).

**3. Feature-flag posture.** The commerce router **mounts unconditionally** in
`routes/index.ts`, and gating is done by middleware inside it. `KAX_COMMERCE_ENABLED` defaults
**off**. Both halves of this are already how the shipped surface behaves —
`routes/index.ts:62` mounts `storeCheckoutRouter` with no condition on it, and the flag is
read per-request inside the router (`store-checkout.ts:16-20`).

**Do not env-gate the mount.** An unmounted route 404s indistinguishably from a bad deploy,
and the first hour of the first commerce incident should not be spent deciding which one
happened. And never the silent degradation of `requireAdminOrServiceToken`, which falls
through to `requireAdmin` when its variable is unset — a gate that gets *weaker* when
misconfigured.

Two response codes, for two different conditions, and the shipped code establishes the second:

- **Flag off.** The shipped digital surface answers `404 {"error":"Not found"}`
  (`store-checkout.ts:18`), the deliberate inert-until-configured idiom recorded in
  `.agents/memory/kax-commerce-gating.md`. That choice stands for the digital surface and is
  not to be "fixed" by removing the gate. **The physical commerce surface answers 503
  instead**, and the reason is the same one that forbids env-gating the mount: 404 is the code
  a broken deploy also returns, and a physical order path that has taken money and shipped
  goods is exactly where an operator must be able to tell "switched off" from "not deployed"
  without reading logs. The digital surface can afford the ambiguity because nothing
  irreversible happens behind it when it is off; the physical one cannot.

  ```
  503 { error: "commerce surface disabled (KAX_COMMERCE_ENABLED unset)" }
  ```

- **Flag on, schema not migrated.** **503, fail closed** — adopted verbatim from the shipped
  gate at `store-checkout.ts:21-32`, which probes `listing_orders` once, caches the verdict,
  and refuses with `{"error":"Commerce enabled but schema not migrated (0025)"}` rather than
  500ing mid-checkout. This is the correct posture and physical commerce reuses the pattern
  against its own tables. Note the one operational consequence of the cached verdict: a
  process that boots before its migration lands stays 503 until it restarts. That is the right
  failure direction, and it is worth naming so nobody debugs it as a stuck cache.

Any service-to-service commerce surface additionally takes a bearer token compared with
`crypto.timingSafeEqual` — **copying `requireLedgerMintToken` exactly**: 503 when the secret is
unset, 401 on mismatch.

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
copy — HMAC over the untouched raw bytes, `timingSafeEqual`, 401 on failure. The shipped
Stripe leg already sits under the prefix (`routes/webhooks.ts:132`) and takes `raw({ type:
"application/json" })`, delegating verification to `stripe-replit-sync`; the Printify webhook
mounts beside it.

**One divergence to record rather than paper over.** This ADR asked that a missing webhook
secret **fail boot in production**, matching `index.ts`'s `requiredSecrets` check. The shipped
Stripe integration does the opposite by construction: `initStripe` runs through
`runStartupStep`, which is non-fatal by design (`index.ts:241-244` — "a connector hiccup must
not take the rest of KAX down"), and with no `STRIPE_WEBHOOK_SECRET` the step registers a
*managed* webhook through `stripeSync.findOrCreateManagedWebhook()` (`index.ts:264`) which
supplies its own secret. So "missing secret" is not actually a misconfiguration in the shipped
design — it is the connector-managed path, and it is why the environment table above marks
`STRIPE_WEBHOOK_SECRET` required only on the dashboard-webhook path.

That holds on **one** of the two credential paths, and the distinction is the operator trap
recorded under "Where credentials come from": the managed webhook's secret reaches
`getStripeSync()` only because `getStripeCredentials()` read it off the connector response
(`stripeClient.ts:68`), and it reads that response only when `STRIPE_SECRET_KEY` was *not* set
in env. **Set an env secret key and leave `STRIPE_WEBHOOK_SECRET` unset and the two halves come
apart**: `initStripe` still takes the `else` branch and registers a managed webhook
(`index.ts:256`, `:264`), because that branch tests the env variable alone — but the secret
that webhook was created with never reaches the verifier, since `getStripeCredentials()`
already returned at `:26-28` and `getStripeSync()` builds `StripeSync` with
`stripeWebhookSecret: ""` (`:98`). Boot logs a success, a webhook exists in the Stripe
dashboard, and every delivery fails verification. Env key and env webhook secret travel
together, or neither does.

The ADR therefore narrows its rule to what is still true and still worth enforcing: **with
`KAX_COMMERCE_ENABLED` on, a Stripe client that cannot be constructed at all must be loud.**
`getStripeCredentials()` throws with an actionable message when neither an env key nor a
connector is present (`stripeClient.ts:37-41`, `:60-64`), but that throw surfaces only on the
first checkout request — a buyer's request — because `runStartupStep` swallowed the same
failure at boot. Commerce must add a **boot-time readiness probe** that attempts credential
resolution once when the flag is on and records the result where `GET /health/schema` and
`GET /version` can be read beside it. The operator turning the flag on should learn in the
deploy log that Stripe is unreachable, not from the first customer.

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
discipline `saleTxId(listingId, buyerAccount)` already applies to Joinery sales — and the same
discipline the shipped checkout already applies to Stripe, with
`kax-listing-product-<id>` and `kax-listing-price-<id>-<cents>` as `idempotencyKey`
(`store-checkout.ts:102`, `:116`) and a unique `stripe_session_id` as the insert conflict
target (`:150`). Physical commerce derives its keys from the `commerce_orders` row rather than
from a listing id, because the row exists first — that is what makes a lost response
reconcilable.

Failures become **explicit state**, not silence:

```
Sticker
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
apparel; many product types; **posters and every other format the source's 1024 px cannot
fill** (unreachable, not deferred — see "What the assets actually measure"); autonomous
advertising; automatic refunds; **autonomous USDC withdrawal** (structurally absent, not
deferred); mass listing generation; fully autonomous publishing; NFC provenance; physical
certificates; advanced analytics; price optimization; cross-platform inventory optimization;
**trademark review**; **likeness review**; multi-merchant Stripe Connect; embedded checkout;
object storage; upscaling.

**v0.2:** Stripe Connect with direct charges (committed above); multi-merchant Printify OAuth;
**upscaling options and derived print masters — the capability that unlocks posters, canvas
and the sticker sizes above 1024 px** (and which makes KAX byte custody required); object
storage; posters, canvas, apparel; larger sticker variants; product recommendation; **richer
rights evidence including trademark and likeness review**; returns and reprints; embedded
checkout; margin optimization; the creator-payout policy decision.

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
  → measured, native-pass printable asset (1024×1024 source, no derived print master)
  → merchant-approved product, pinned by content hash
  → one physical sticker
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
work. The product is small: a 3-to-3.5-inch sticker, because that is the largest object the
measured corpus can fill without an upscaler, and the poster this ADR originally committed to
turns out to be unreachable: the smallest poster Printify sells needs a print file 2.6× wider
than the source, and the 12 × 12 the earlier draft illustrated is not a variant in the
catalogue at all. Two of the five rights assertions ship as merchant attestations rather than
checks, and two more do not ship at all. Checkout throws the buyer out of the 3D city and back.
And the external accounts must be provisioned before a single line of the proof can be
executed — **three operator dependencies remain**, register items 2–4: a Printify payment method
on file whose billing trigger is still unverified, the Stripe activation, and the legal merchant
entity. Items 1 and 1b are off that list: the Printify token is verified and the dedicated
store `28604869` exists, is `custom_integration`, and answers the API.

**What it inherits.** A working Stripe integration — client, credential resolution, hosted
Checkout, signature-verified webhook, webhook-driven settlement, feature flag, fail-closed
schema gate — arrived on `main` while this ADR was being written, and roughly a third of the
"genuinely new subsystem" column is now already built. It also arrived carrying issue #269,
which is the second appearance in this repository of a money column that does not name its
unit, and the first one where the mistake is denominated in dollars. That is the honest
summary of what a concurrent session bought and what it cost: the checkout is real and is
kept; the flag must stay off until the unit is named.

**What is still undecided, and who decides.** How a third-party creator is paid a real-money
share (operator: house-minted credits at the peg, or Connect sub-merchant — different
regulatory weight). Whether KAX or the merchant is tax collector of record under
marketplace-facilitator statutes once v0.2 merchants exist (operator, with advice). Whether
Printify charges at order-submit time (**still unverified** — it needs one manual order through
Printify's own UI, and it changes the dependency register). Which Printify shop KAX publishes
into (**resolved 2026-08-16** — shop `28604869`, `custom_integration`; the existing Shopify-channel
shop 28599902 is not it, and nothing may default to it). Which of the two measured sticker specs v0.1 ships —
3.5 in vinyl on blueprint 476/73/65212, or 3 in kiss-cut on 400/99/45750 (operator; both are
native passes, so this is a product judgement rather than an engineering constraint). Whether
the signup grant is inside or outside the purchase caps (operator, with a named reason recorded
in code either way).

Each of those is named here rather than defaulted, because a defaulted answer to any of them
would read, later, exactly like a decision.
