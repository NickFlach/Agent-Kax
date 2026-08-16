-- Stripe checkout for store listings.
-- NOTE: the `stripe` schema itself (products, prices, customers, ...) is
-- created and managed by stripe-replit-sync's own runMigrations() at boot —
-- never here. This migration only adds OUR application-side tables/columns.
-- Fully idempotent (safe for UNMARK_SAFE_MIGRATIONS).

-- Lazily-created Stripe catalog ids for a listing (one product+price per
-- priced listing, created at first checkout).
ALTER TABLE store_listings ADD COLUMN IF NOT EXISTS stripe_product_id TEXT;
ALTER TABLE store_listings ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;

-- One row per checkout attempt. Stripe remains the source of truth for
-- payment state; this table just ties a Checkout Session to the listing and
-- buyer so the app can show purchases and fulfill them.
CREATE TABLE IF NOT EXISTS listing_orders (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES store_listings(id) ON DELETE CASCADE,
  buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_session_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | canceled
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS listing_orders_buyer_idx ON listing_orders(buyer_user_id);
CREATE INDEX IF NOT EXISTS listing_orders_listing_idx ON listing_orders(listing_id);
