-- #257 (KAX-ADR-0002), reconciled against the tables another session already
-- landed (0025/0026): commerce_products and commerce_orders EXIST with a live
-- checkout and fulfillment worker on them, so this migration is ADDITIVE —
-- the missing merchant/state/approval columns and the full money-leg set.
--
-- Naming equivalences, documented rather than renamed (renaming live columns
-- under a running worker is gratuitous risk):
--   issue name              existing column
--   item_price_cents     == item_cents
--   shipping_charged_cents == shipping_cents
--   tax_collected_cents  == tax_cents
--   external_ref         == client_reference (unique, the idempotency key)
--   pod_order_id         == printify_order_id
--   stripe_payment_intent== stripe_payment_intent_id
--
-- All state columns varchar, never pgEnum. No FK to any table the deploy
-- diff can drop.

-- Products: who sells it, which spec, where it stands, and the approval pin.
ALTER TABLE commerce_products ADD COLUMN IF NOT EXISTS merchant_id integer REFERENCES commerce_merchants(id) ON DELETE RESTRICT;
ALTER TABLE commerce_products ADD COLUMN IF NOT EXISTS product_spec_id varchar(48);
ALTER TABLE commerce_products ADD COLUMN IF NOT EXISTS commerce_state varchar(32) NOT NULL DEFAULT 'not_evaluated';
ALTER TABLE commerce_products ADD COLUMN IF NOT EXISTS printify_blueprint_id varchar;
ALTER TABLE commerce_products ADD COLUMN IF NOT EXISTS approved_content_hash text;
ALTER TABLE commerce_products ADD COLUMN IF NOT EXISTS approved_by varchar REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE commerce_products ADD COLUMN IF NOT EXISTS approved_at timestamp;
ALTER TABLE commerce_products ADD COLUMN IF NOT EXISTS unpublished_at timestamp;
CREATE UNIQUE INDEX IF NOT EXISTS commerce_products_merchant_artifact_spec_idx
  ON commerce_products (merchant_id, artifact_id, product_spec_id);

-- Orders: the legs margin is actually computed from. Every field an integer
-- of USD cents named with its unit.
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS customer_charge_cents integer;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS tax_jurisdiction varchar(48);
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS tax_rate_bps integer;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS tax_collector_of_record varchar(16); -- kax|merchant
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS processor_fee_cents integer;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS processor_fee_bearer varchar(16);     -- platform|merchant
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS platform_fee_cents integer;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS platform_fee_rate_bps integer;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS platform_fee_basis varchar(24);       -- item_price|customer_charge
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS fulfillment_cost_cents integer;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS fulfillment_shipping_cost_cents integer;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS fulfillment_cost_payer varchar(16);   -- kax|merchant
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS fulfillment_paid_at timestamp;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS merchant_net_cents integer;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS stripe_charge_id varchar;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS tax_provider_txn varchar;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS correlation_id text;

-- Settlement refs, each indexed (the existing payment-intent and printify
-- ids included, in case their indexes never landed).
CREATE INDEX IF NOT EXISTS commerce_orders_stripe_pi_idx ON commerce_orders (stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS commerce_orders_stripe_charge_idx ON commerce_orders (stripe_charge_id);
CREATE INDEX IF NOT EXISTS commerce_orders_pod_order_idx ON commerce_orders (printify_order_id);
CREATE INDEX IF NOT EXISTS commerce_orders_tax_txn_idx ON commerce_orders (tax_provider_txn);
