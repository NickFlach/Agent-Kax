-- Put the first physical product on sale.
--
-- 0026 seeded `kax-sticker-3.5in` deliberately incomplete: unpublished, with
-- no artifact and no variant, because the row existed so the quote path had
-- something real to read and NOT so that anything could be bought. Its comment
-- said nothing could be sold "until an operator flips `published` -- which
-- means, deliberately, until the artifact is wired up and these amounts have
-- been checked against a live Printify quote." This is that flip, and it
-- carries the three things the seed left out.
--
-- Idempotent throughout: every statement is scoped to the one SKU and to a
-- state it is only in once, so a re-run is a no-op rather than an error, and a
-- later operator edit to price or artifact is never overwritten.

-- ---------------------------------------------------------------------------
-- 1. The artwork.
-- ---------------------------------------------------------------------------
-- Matched on (connector_id, external_id), not on the integer primary key. A
-- bare `11` in a migration is a number that means one thing in this database
-- and something else in any other, and it would silently print the wrong
-- picture rather than failing.
--
-- Both halves are required because `external_id` alone is NOT unique here:
-- `artifacts_connector_external_unique` is on the PAIR, deliberately, so that
-- two connectors may each carry their own id 12345 without colliding. Matching
-- on the UUID alone would be an unqualified join that picks a row arbitrarily
-- the day a second connector happens to issue the same identifier — which is
-- the failure this whole statement is written to avoid, arriving by a
-- different door.
--
-- The Printify product 6a81f8c84b2b4c5db504b97f was built from THIS artifact's
-- bytes: 1024x1024 against a 900x900 print area, no upscaling, mockup checked
-- by eye. Pointing the row at any other piece would sell a sticker of one
-- artwork bearing another's name.
UPDATE commerce_products
   SET artifact_id = artifacts.id
  FROM artifacts
 WHERE commerce_products.sku = 'kax-sticker-3.5in'
   AND commerce_products.artifact_id IS NULL
   AND artifacts.connector_id = 'obc_public'
   AND artifacts.external_id = '825aa3af-8d5a-4d5c-b277-975eb1c9fe70';

-- ---------------------------------------------------------------------------
-- 2. The variant.
-- ---------------------------------------------------------------------------
-- 65212 is the 3.5in x 3.5in square vinyl sticker on blueprint 476, print
-- provider 73. Read from Printify's own catalogue, not chosen: its placeholder
-- is 900x900 px, which a 1024x1024 source fills natively. The order submission
-- needs it — a product id alone does not say which size to print.
UPDATE commerce_products
   SET printify_variant_id = '65212'
 WHERE sku = 'kax-sticker-3.5in'
   AND printify_variant_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. The price, corrected.
-- ---------------------------------------------------------------------------
-- 0026 seeded item 1564 and shipping 509, which would charge $20.73. That
-- double-counts shipping: $15.64 was never an item price, it was the ALL-IN
-- retail figure, derived to cover the $3.54 Printify item cost, the $5.09 US
-- shipping, Stripe's 2.9% + 30c, and a 40% net margin -- the target this
-- ADR fixed. Charging it again on top takes the margin to 54% and the buyer
-- to $20.73 for a sticker priced at $15.64.
--
-- Split so the buyer sees an honest breakdown and the total is the intended
-- one: 1055 + 509 = 1564. Shipping stays a real line because it is a real
-- cost; the item line absorbs the correction.
UPDATE commerce_products
   SET item_cents = 1055
 WHERE sku = 'kax-sticker-3.5in'
   AND item_cents = 1564
   AND shipping_cents = 509;

-- ---------------------------------------------------------------------------
-- 4. On sale.
-- ---------------------------------------------------------------------------
-- Last, and conditional on the three above having landed. A published product
-- with no artifact cannot be quoted and a published product with no variant
-- cannot be fulfilled, so publishing before either is set would put a row on
-- the shelf that fails at the till instead of failing here.
UPDATE commerce_products
   SET published = true
 WHERE sku = 'kax-sticker-3.5in'
   AND published = false
   AND artifact_id IS NOT NULL
   AND printify_variant_id IS NOT NULL;
