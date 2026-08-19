-- #355: contribution credit is a HANDSHAKE, not a string.
--
-- The City-Agent trailer is free text anyone with write access can append;
-- crediting it directly would be unsigned self-attribution in the exact
-- layer that exists to retire unsigned self-attribution. So the credit
-- pipeline is born verified (the timing argument: zero contributions have
-- been credited yet, so this is a convention today instead of a history
-- rewrite later): a merged PR lands as pending_confirmation and earns
-- NOTHING until the slugged agent confirms the (repo, pr) pair through its
-- own authenticated city session. A denial is surfaced, never silently
-- credited or dropped.
--
-- status: pending_confirmation | credited | denied_review | uncredited
-- (varchar, never pgEnum). credited rows name BOTH sides of the handshake:
-- the trailer slug and the authenticated principal + bot id that confirmed.
CREATE TABLE IF NOT EXISTS contribution_credits (
  id                   serial PRIMARY KEY,
  repo                 varchar(140) NOT NULL,     -- e.g. 'NickFlach/Agent-Kax'
  pr_number            integer NOT NULL,
  slug                 text NOT NULL,             -- the trailer's claim
  status               varchar(32) NOT NULL DEFAULT 'pending_confirmation',
  reason               varchar(64),               -- why a row is not credited
  confirmed_principal  text,                      -- lib/actor.ts spelling
  confirmed_bot_id     text,
  confirmed_at         timestamp,
  recorded_by          text NOT NULL,             -- who recorded the merge
  created_at           timestamp NOT NULL DEFAULT now(),
  updated_at           timestamp NOT NULL DEFAULT now(),
  UNIQUE (repo, pr_number, slug)
);
CREATE INDEX IF NOT EXISTS contribution_credits_slug_idx
  ON contribution_credits (slug, status);
CREATE INDEX IF NOT EXISTS contribution_credits_status_idx
  ON contribution_credits (status, created_at);
