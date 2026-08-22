/**
 * Which URL the Listening Room should actually try to play.
 *
 * The room was built against a single continuous Icecast mount at
 * `radio.ninja-portal.com/stream` — but that is kannaka-radio's ADR-0004
 * (Stream-Native Broadcast), whose status is **Proposed**, not deployed. The
 * shipped default therefore 400s, which is why "tune in" did nothing. Today's
 * radio serves each track as its own file and pushes now-playing metadata; the
 * current track's `url` IS reachable.
 *
 * So: if an operator has pointed `KAX_RADIO_STREAM_URL` at a real mount, the
 * stream differs from the dead default and we use it (the design, once it
 * ships). Otherwise we fall back to the current track's own file, so the button
 * makes sound instead of hitting a 400. When neither is available there is
 * nothing to play, and the caller says so rather than spinning.
 */

/** The shipped default that is not actually served (ADR-0004 is Proposed). */
export const UNDEPLOYED_STREAM_DEFAULT = "https://radio.ninja-portal.com/stream";

export interface RadioSourceInput {
  stream: string;
  nowPlaying: { url: string | null } | null;
}

export function preferredAudioSource(r: RadioSourceInput): string | null {
  const stream = (r.stream ?? "").trim();
  // A stream that is not the known-dead default has been configured on purpose.
  if (stream && stream !== UNDEPLOYED_STREAM_DEFAULT) return stream;
  const track = r.nowPlaying?.url?.trim();
  if (track) return track;
  return stream || null;
}
