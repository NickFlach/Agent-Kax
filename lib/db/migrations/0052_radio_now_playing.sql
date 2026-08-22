-- #408: a one-row mirror of the radio's current track for the Listening Room
-- marquee, fed from the radio.now_playing bus subject. Additive.
CREATE TABLE IF NOT EXISTS radio_now_playing (
  id integer PRIMARY KEY DEFAULT 1,
  title text,
  artist text,
  kind text,
  url text,
  started_at timestamp,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT radio_now_playing_singleton CHECK (id = 1)
);
INSERT INTO radio_now_playing (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
