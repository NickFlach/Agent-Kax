-- Physical commerce: real dollars, a real card, and something that arrives in
-- the post (#282, epic #241).
--
-- One migration for all of it, so nothing half-lands. A migration runs inside
-- one transaction and a migration failure is FATAL on deploy, so every
-- statement here is idempotent — CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, CREATE INDEX IF NOT EXISTS, and an ON CONFLICT DO NOTHING seed.
-- Re-running this file against a database that already has it must be a
-- no-op, not an error.
--
-- Every amount below is an INTEGER of USD cents in a column named for its
-- unit. That is the structural half of the rule that play_credit can never buy
-- a physical good: this path never reads `store_listings.price`, whose single
-- `real` column means play_credit minor units to lib/joinery.ts and USD
-- dollars to routes/store-checkout.ts (#269), and no code path from these
-- tables reaches the credit ledger at all.
--
-- Status columns are varchar and NOT pgEnum, throughout. An unknown enum
-- literal in a WHERE clause is a 500, not a query that matches nothing, and
-- the deploy diff has separately proposed DROP TYPE on an enum it did not
-- recognise. The permitted values are documented beside each column and
-- enforced by the application.

-- ---------------------------------------------------------------------------
-- The buyer's side: where to send it, what to charge, and their agreement.
-- ---------------------------------------------------------------------------

-- Child tables, not columns on `users`, following the user_bots precedent. An
-- order has to snapshot the address it shipped to, and "send this one
-- somewhere else" is a foreseeable need that columns on the user row cannot
-- express -- the moment a second address exists, columns are a migration and a
-- child table is a new row.
--
-- Addresses are ARCHIVED rather than updated. Editing in place would silently
-- rewrite what a past order can be checked against; archived_at keeps the old
-- value readable while the partial unique index below still allows only one
-- live address per user.
--
-- This is the first postal PII in this schema. It is never logged, never put
-- in an error message, and never returned from a public or agent-facing
-- endpoint.
CREATE TABLE IF NOT EXISTS user_shipping_addresses (
  id                 varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               varchar NOT NULL,
  line1              varchar NOT NULL,
  line2              varchar,
  city               varchar NOT NULL,
  region             varchar NOT NULL,
  postal_code        varchar NOT NULL,
  country            varchar NOT NULL,
  phone              varchar,
  -- Stamped only when something actually checked the address. NULL means the
  -- buyer typed it and nobody confirmed it, which is a materially different
  -- thing to tell a fulfilment provider.
  validated_at       timestamptz,
  validation_method  varchar,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_shipping_addresses_user_idx
  ON user_shipping_addresses (user_id);

-- One LIVE address per user. Partial, so the archived history is unconstrained
-- and a move does not have to destroy the previous address to be recorded.
CREATE UNIQUE INDEX IF NOT EXISTS user_shipping_addresses_live_unique
  ON user_shipping_addresses (user_id) WHERE archived_at IS NULL;

-- Display metadata only. Brand, last four and expiry are explicitly outside
-- PCI scope; the card itself lives at Stripe behind stripe_payment_method_id,
-- and that id is derived server-side by retrieving the SetupIntent, never
-- accepted from a client -- otherwise one user can attach another's card.
--
-- detached_at rather than a delete: Stripe emits payment_method.detached for
-- cards removed from its dashboard too, and an account whose card silently
-- vanished is indistinguishable from one that never had a card. The row is
-- what lets the buyer be told which it was.
CREATE TABLE IF NOT EXISTS user_payment_methods (
  id                        varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_payment_method_id  varchar NOT NULL UNIQUE,
  brand                     varchar,
  last4                     varchar,
  exp_month                 integer,
  exp_year                  integer,
  is_default                boolean NOT NULL DEFAULT false,
  detached_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_payment_methods_user_idx
  ON user_payment_methods (user_id);

-- The buyer agreeing that we may keep their card and charge it. A new
-- acceptance is a new row, so bumping the terms makes prior consents visibly
-- stale instead of overwriting the evidence that they happened.
--
-- terms_sha256 is the hash of the document the server actually served,
-- computed server-side. A version string alone records which file was named,
-- not what it said. ip and user_agent are the circumstances of the acceptance,
-- which is exactly what a disputed charge asks about.
CREATE TABLE IF NOT EXISTS user_purchasing_consents (
  id             varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version  varchar NOT NULL,
  terms_sha256   varchar NOT NULL,
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  ip             varchar,
  user_agent     text
);

CREATE INDEX IF NOT EXISTS user_purchasing_consents_user_idx
  ON user_purchasing_consents (user_id, accepted_at);

-- The Stripe Customer this account's saved cards hang off. On `users` rather
-- than on user_payment_methods because it outlives any one card: removing the
-- last card must not orphan the Customer and mint a second one on the next
-- attempt, which would leave the same human with two payment histories at
-- Stripe.
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text;

CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_id_unique
  ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The product, and the order.
-- ---------------------------------------------------------------------------

-- Keyed on sku, not on an artifact: the same artifact is a different product
-- as a 3.5in sticker than as a 12 x 18 poster, with different print
-- requirements and a different price, so a per-artifact identity would be a
-- lie about at least one of them.
--
-- artifact_id is nullable with ON DELETE SET NULL. The product row is created
-- before anyone has chosen the piece, and deleting an artifact must not delete
-- the record of a product that has already been sold. A published product with
-- no artifact cannot be quoted; that check belongs to the route, not to a NOT
-- NULL that would make the seed below impossible.
--
-- ship_to_countries is a real array, so an address outside the list is refused
-- with "we can't ship to GB yet" rather than a generic failure.
CREATE TABLE IF NOT EXISTS commerce_products (
  id                   serial PRIMARY KEY,
  sku                  varchar NOT NULL UNIQUE,
  title                varchar NOT NULL,
  artifact_id          integer REFERENCES artifacts(id) ON DELETE SET NULL,
  printify_product_id  varchar,
  printify_variant_id  varchar,
  item_cents           integer NOT NULL,
  shipping_cents       integer NOT NULL DEFAULT 0,
  currency             varchar NOT NULL DEFAULT 'usd',
  published            boolean NOT NULL DEFAULT false,
  ship_to_countries    text[]  NOT NULL DEFAULT '{US}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commerce_products_published_idx
  ON commerce_products (published);

-- One purchase of a physical product. This row IS the commerce record of
-- truth: v0.1 adds no ledger, and the normalized commerce event is a
-- projection of these columns.
--
-- client_reference is UNIQUE and is the idempotency key for the whole
-- purchase. It is minted once per press of the Buy button and reused across
-- every retry, so the row is written first with ON CONFLICT DO NOTHING on this
-- target and only then is Stripe called, under a key derived from the row.
-- Charging Stripe before the row exists makes a lost response unreconcilable;
-- the reverse order is recoverable by reading the row back.
--
-- THE SHIPPING ADDRESS IS SNAPSHOTTED. The ship_to_* columns are copies taken
-- at charge time and there is deliberately NO foreign key to
-- user_shipping_addresses. A buyer who moves house and edits their address
-- would otherwise rewrite where an already-shipped order went, and take the
-- dispute evidence with it. The Printify submission builds address_to from
-- these columns and never from a live join.
--
-- NO foreign key to store_listings or listing_orders. Those belong to the
-- digital path: listing_id's cascade would let a delisting destroy the record
-- of a card charge, this table is keyed on a product rather than a listing,
-- and listing_orders.status has three values where this lifecycle has a dozen.
-- The two order tables are never joined and never unioned.
CREATE TABLE IF NOT EXISTS commerce_orders (
  id                        serial PRIMARY KEY,
  client_reference          varchar NOT NULL UNIQUE,
  buyer_user_id             varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The product as sold, by key. Not a foreign key: repricing or unpublishing
  -- a product must not retroactively change what an order says was bought.
  sku                       varchar NOT NULL,
  currency                  varchar NOT NULL DEFAULT 'usd',
  item_cents                integer NOT NULL,
  shipping_cents            integer NOT NULL DEFAULT 0,
  -- Zero in v0.1 and present anyway. With no active registration Stripe Tax
  -- returns zero SILENTLY -- a wrong answer, not an error -- so the column
  -- exists from day one and turning tax on later is a code change rather than
  -- a migration against live orders.
  tax_cents                 integer NOT NULL DEFAULT 0,
  -- What the card was actually charged. Stored, not recomputed at read time.
  total_cents               integer NOT NULL,
  ship_to_name              varchar NOT NULL,
  ship_to_line1             varchar NOT NULL,
  ship_to_line2             varchar,
  ship_to_city              varchar NOT NULL,
  ship_to_region            varchar NOT NULL,
  ship_to_postal_code       varchar NOT NULL,
  ship_to_country           varchar NOT NULL,
  ship_to_phone             varchar,
  stripe_payment_intent_id  varchar,
  -- pending_payment | authenticating | paid | payment_failed | canceled |
  -- refunded | chargeback. `paid` is the fourth state and not the last one,
  -- which is the whole reason this is not listing_orders.status widened.
  status                    varchar NOT NULL DEFAULT 'pending_payment',
  -- unfulfilled | submitted | in_production | shipped | delivered | canceled.
  -- Separate from status because they answer different questions on different
  -- clocks: a paid order is unfulfilled until someone submits it, and a
  -- shipped order can still go to chargeback.
  fulfillment_state         varchar NOT NULL DEFAULT 'unfulfilled',
  printify_order_id         varchar,
  submitted_at              timestamptz,
  released_at               timestamptz,
  -- Who pressed release. Sending an order to production is a human decision
  -- and it is recorded as one.
  release_actor             varchar,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commerce_orders_buyer_idx
  ON commerce_orders (buyer_user_id);

-- The webhook arrives knowing only the PaymentIntent.
CREATE INDEX IF NOT EXISTS commerce_orders_payment_intent_idx
  ON commerce_orders (stripe_payment_intent_id);

-- The stuck-`authenticating` sweep reads by state and age; without this it is
-- a sequential scan over every order ever placed.
CREATE INDEX IF NOT EXISTS commerce_orders_status_idx
  ON commerce_orders (status, created_at);

-- The v0.1 product, seeded UNPUBLISHED.
--
-- The row exists so the quote path has something real to read and so the
-- prices are recorded here rather than in a constant somewhere, but nothing
-- can be sold until an operator flips `published` -- which means, deliberately,
-- until the artifact is wired up and these amounts have been checked against a
-- live Printify quote. $15.64 item, $5.09 US shipping, $20.73 total.
--
-- ON CONFLICT DO NOTHING on the sku so a re-run never overwrites an operator's
-- edits to price, artifact, or published state.
INSERT INTO commerce_products
  (sku, title, item_cents, shipping_cents, published, printify_product_id, ship_to_countries)
VALUES
  ('kax-sticker-3.5in', 'KAX Sticker · 3.5in vinyl', 1564, 509, false,
   '6a81f8c84b2b4c5db504b97f', '{US}')
ON CONFLICT (sku) DO NOTHING;
