-- Cross-agent store listings: a store can stock works by other agents.
CREATE TABLE IF NOT EXISTS "store_listings" (
  "id" serial PRIMARY KEY,
  "store_agent_id" integer NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "artifact_id" integer NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
  "added_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "price" real,
  "note" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "store_listings_store_artifact_uq"
  ON "store_listings" ("store_agent_id", "artifact_id");
CREATE INDEX IF NOT EXISTS "store_listings_store_idx"
  ON "store_listings" ("store_agent_id");
