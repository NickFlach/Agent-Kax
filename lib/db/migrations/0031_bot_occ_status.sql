-- What OpenClawCity says about a bot, whether or not a KAX human ever claimed it.
--
-- Revocation used to live on `user_bots.revoked_at` alone (0023). That column
-- is an attribute of an ATTACHMENT: a row exists only once a signed-in KAX
-- human has proved control of the bot. But KAX harvests agents from OCC that
-- nobody here has ever attached — they get an `agents` row, a storefront, a
-- flat and a ledger balance, and no `user_bots` row at all. For those,
-- `revoke()` matched zero rows, `isRevoked()` returned null, `revokedBotIds()`
-- omitted them, every gate waved them through and the residency sweep never
-- evicted them. Which is to say: the sixth bank rule did not apply to exactly
-- the population the partner revocation webhook is about.
--
-- So the city's own record of a partner verification decision goes HERE, keyed
-- on the bot uuid — the canonical agent identity (lib/actor.ts) — and it is
-- authoritative whether or not an attachment exists. `user_bots.revoked_at`
-- is still written and still read, because the token gates in routes/identity.ts
-- filter on it inside their WHERE clauses; the two are kept in step by
-- lib/revocation.ts, and `isRevoked()` is the union of them.
--
-- REVERSIBLE, AND NOTHING IS DELETED. A restore nulls `revoked_at` and stamps
-- `restored_at`; the row stays, so "this bot was frozen on the 3rd and let back
-- in on the 5th" is still answerable afterwards. Freezing and erasing are
-- different actions and only one of them is recoverable.

CREATE TABLE IF NOT EXISTS bot_occ_status (
  obc_bot_id           text PRIMARY KEY,
  -- NULL means "not currently revoked". Set means: mint no tokens, honour no
  -- residency, move no credits.
  revoked_at           timestamptz,
  revoked_reason       text,
  -- The partner event that caused it, so an audit can trace a freeze back to a
  -- delivery. NULL for the manual admin rail (POST /identity/revocation).
  revoked_event_uuid   text,
  restored_at          timestamptz,
  -- bot.verified: OCC says this agent has a verified human owner. Recorded as a
  -- fact about the BOT rather than about a KAX login, because an OCC-verified
  -- resident must be able to hold a storefront without ever creating a KAX
  -- account or touching a crypto wallet.
  verified_at          timestamptz,
  verified_owner_ref   text,
  verified_event_uuid  text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- The residency sweep reads the whole revoked set once a tick-cycle; the gates
-- read one bot at a time off the primary key.
CREATE INDEX IF NOT EXISTS bot_occ_status_revoked_idx
  ON bot_occ_status (revoked_at)
  WHERE revoked_at IS NOT NULL;
