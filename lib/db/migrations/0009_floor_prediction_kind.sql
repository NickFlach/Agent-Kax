-- Settled predictions from the observatory's prediction registry are
-- witnessed into the Floor Ledger as their own kind.

ALTER TYPE "floor_deal_kind" ADD VALUE IF NOT EXISTS 'prediction';
