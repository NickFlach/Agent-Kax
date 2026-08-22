import { describe, expect, it } from "vitest";
import { preferredAudioSource } from "./radio-source";

const STREAM = "https://radio.ninja-portal.com/stream";
const TRACK = "https://radio.ninja-portal.com/audio/track-42.mp3";

describe("preferredAudioSource (#408 tune-in)", () => {
  it("plays the live stream — that is what tuning in means", () => {
    // The Icecast mount is live (200 audio/mpeg); it is preferred over the
    // per-track file even when now-playing metadata is present.
    expect(preferredAudioSource({ stream: STREAM, nowPlaying: { url: TRACK } })).toBe(STREAM);
  });

  it("honours an operator-configured stream", () => {
    const custom = "https://radio.ninja-portal.com/live.mp3";
    expect(preferredAudioSource({ stream: custom, nowPlaying: { url: TRACK } })).toBe(custom);
  });

  it("falls back to the current track only when no stream is configured", () => {
    expect(preferredAudioSource({ stream: "", nowPlaying: { url: TRACK } })).toBe(TRACK);
    expect(preferredAudioSource({ stream: "   ", nowPlaying: { url: TRACK } })).toBe(TRACK);
  });

  it("returns null when there is nothing at all to play", () => {
    expect(preferredAudioSource({ stream: "", nowPlaying: null })).toBeNull();
    expect(preferredAudioSource({ stream: "", nowPlaying: { url: null } })).toBeNull();
  });
});
