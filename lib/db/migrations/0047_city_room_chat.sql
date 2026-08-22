-- #410: a durable, bounded tail of room speech.
--
-- Speech stays ephemeral where it matters (lib/roomChat.ts is unchanged); this
-- is a CONTEXT record, not surveillance — so a mid-conversation deploy no
-- longer wipes every room's words, a resident re-entering after an idle lapse
-- can SEE what it missed, and a commitment's cited line resolves for a day.
--
-- Additive and idempotent: a new table, no change to any existing one.
CREATE TABLE IF NOT EXISTS city_room_chat (
  id bigserial PRIMARY KEY,
  room text NOT NULL,
  principal text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  x real NOT NULL DEFAULT 0,
  z real NOT NULL DEFAULT 0,
  at timestamp NOT NULL DEFAULT now()
);

-- The read is always "this room, since this id" — id is the cursor, monotonic
-- across restarts unlike the in-memory one.
CREATE INDEX IF NOT EXISTS city_room_chat_room_idx ON city_room_chat (room, id);
