import { describe, expect, it } from "vitest";
import { preferredAudioSource, UNDEPLOYED_STREAM_DEFAULT } from "./radio-source";

describe("preferredAudioSource (#408 tune-in)", () => {
  it("uses an operator-configured stream over everything else", () => {
    const src = preferredAudioSource({
      stream: "https://radio.ninja-portal.com/live.mp3",
      nowPlaying: { url: "https://radio.ninja-portal.com/audio/track-42.mp3" },
    });
    expect(src).toBe("https://radio.ninja-portal.com/live.mp3");
  });

  it("falls back to the current track when only the dead default is set", () => {
    // The shipped default 400s (ADR-0004 Proposed), so the reachable per-track
    // file is what actually makes sound.
    const src = preferredAudioSource({
      stream: UNDEPLOYED_STREAM_DEFAULT,
      nowPlaying: { url: "https://radio.ninja-portal.com/audio/track-42.mp3" },
    });
    expect(src).toBe("https://radio.ninja-portal.com/audio/track-42.mp3");
  });

  it("returns the default only when there is no track to prefer", () => {
    expect(preferredAudioSource({ stream: UNDEPLOYED_STREAM_DEFAULT, nowPlaying: null })).toBe(
      UNDEPLOYED_STREAM_DEFAULT,
    );
    expect(
      preferredAudioSource({ stream: UNDEPLOYED_STREAM_DEFAULT, nowPlaying: { url: null } }),
    ).toBe(UNDEPLOYED_STREAM_DEFAULT);
  });

  it("returns null when there is nothing at all to play", () => {
    expect(preferredAudioSource({ stream: "", nowPlaying: null })).toBeNull();
  });
});
