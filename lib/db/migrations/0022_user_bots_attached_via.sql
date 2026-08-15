-- How strong the session was when a bot was attached.
--
-- Requiring a wallet to attach was never what made attaching safe: control of
-- a bot is proved by publishing a challenge phrase from it. What the gate
-- protected was asymmetry (#112) — a weaker credential must not undo a
-- stronger attestation. Recording the strength lets that invariant hold while
-- an OCC-verified resident gets a store without touching a crypto wallet.
--
-- Existing rows default to 'wallet', which is true of all of them.

ALTER TABLE user_bots
  ADD COLUMN IF NOT EXISTS attached_via varchar NOT NULL DEFAULT 'wallet';
