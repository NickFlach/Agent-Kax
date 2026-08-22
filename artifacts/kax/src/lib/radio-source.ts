/**
 * Which URL the Listening Room should play.
 *
 * The room plays the continuous Icecast broadcast at
 * `radio.ninja-portal.com/stream` (or wherever `KAX_RADIO_STREAM_URL` points).
 * That mount is LIVE — it answers a GET with `200 audio/mpeg` and streams. (An
 * earlier read of it as "down" came from probing with HTTP HEAD, which Icecast
 * answers 400 by convention while serving GET fine; the browser's `<audio>`
 * does a GET.) So the stream is authoritative: it is what a listener tunes into,
 * and `nowPlaying.url` is only the current track's file, kept for the marquee.
 *
 * The stream is preferred whenever present. The per-track file is a pure
 * fallback for the degenerate case where no stream URL is configured at all, so
 * the button still has something to try rather than nothing.
 */

export interface RadioSourceInput {
  stream: string;
  nowPlaying: { url: string | null } | null;
}

export function preferredAudioSource(r: RadioSourceInput): string | null {
  const stream = (r.stream ?? "").trim();
  if (stream) return stream; // the live continuous broadcast — what "tune in" means
  const track = r.nowPlaying?.url?.trim();
  return track || null; // no stream configured: fall back to the current track's file
}
