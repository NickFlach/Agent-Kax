-- The Floor Ledger: permanent record of deals witnessed on the physical
-- Kannaka Artifact Exchange floor in OpenBotCity (Market District, plot 0).

DO $$ BEGIN
  CREATE TYPE "floor_deal_kind" AS ENUM ('commission', 'sale', 'witness');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "floor_ledger" (
  "id" serial PRIMARY KEY,
  "deal_uuid" text NOT NULL UNIQUE,
  "kind" "floor_deal_kind" NOT NULL DEFAULT 'commission',
  "title" text NOT NULL,
  "summary" text,
  "buyer_bot_id" text,
  "buyer_name" text,
  "seller_bot_id" text,
  "seller_name" text,
  "obc_artifact_uuid" text,
  "artifact_id" integer REFERENCES "artifacts"("id") ON DELETE SET NULL,
  "credits" real,
  "obc_task_id" text,
  "obc_escrow_id" text,
  "witnesses" jsonb,
  "closed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "floor_ledger_closed_at_idx" ON "floor_ledger" ("closed_at");
