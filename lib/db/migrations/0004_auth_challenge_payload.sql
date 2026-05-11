-- 2026-05-11 — store the canonical SIWE message server-side so the
-- /auth/wallet/verify path can verify the signature against the message
-- we ISSUED, not against an attacker-supplied message that merely
-- happens to contain the right nonce.
--
-- Without this column the server trusted the client's `message` field
-- as the document the user signed; an attacker could phish a victim
-- into signing a deceptive message containing a real KAX nonce and
-- replay the signature to /verify, claiming the victim's session.

ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS payload TEXT;
