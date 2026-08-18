/**
 * room-transcript.test.ts — a conversation you can scroll back through.
 *
 * Nick, standing in Flaukowski's Cafe with three agents in it on 2026-08-18:
 * "I can talk but I don't see them respond. Every now and then I see their
 * words but not often."
 *
 * The lines were arriving. `usePresence` filtered its own state down to
 * `BUBBLE_MS` — eight seconds — so anything older was discarded by the client
 * before it could ever be shown twice. Two agents thinking out loud every few
 * minutes gave him roughly eight seconds of visibility per exchange, and only
 * if he was facing the speaker.
 *
 * The identity check below is the one that matters most in practice: the beat
 * runs every 900 ms, and a new array each time would re-render the pane about
 * seventy times a minute and fight the scrollbar.
 */

import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_MAX,
  mergeTranscript,
  transcriptClock,
  unreadSince,
  type TranscriptLine,
} from "./room-transcript";

const line = (id: number, name = "Kannaka", at = 1_700_000_000_000 + id): TranscriptLine => ({
  id,
  principal: `kax:agent:${name}`,
  name,
  text: `line ${id}`,
  at,
});

describe("mergeTranscript", () => {
  it("keeps what was said instead of dropping it after eight seconds", () => {
    const t = mergeTranscript(mergeTranscript([], [line(1)]), [line(2)]);
    expect(t.map((l) => l.id)).toEqual([1, 2]);
  });

  it("returns the SAME array when nothing is new — the beat is 900ms", () => {
    const prev = mergeTranscript([], [line(1), line(2)]);
    expect(mergeTranscript(prev, [])).toBe(prev);
    // A redelivery is also "nothing new".
    expect(mergeTranscript(prev, [line(2)])).toBe(prev);
  });

  it("dedupes a line delivered twice", () => {
    // A visibility-change beat can overlap the scheduled one and carry the
    // same line as the tick before it.
    const prev = mergeTranscript([], [line(1), line(2)]);
    const t = mergeTranscript(prev, [line(2), line(3)]);
    expect(t.map((l) => l.id)).toEqual([1, 2, 3]);
  });

  it("orders by id, because two lines can share a millisecond", () => {
    const same = 1_700_000_000_000;
    const t = mergeTranscript([], [line(3, "A", same), line(1, "B", same), line(2, "C", same)]);
    expect(t.map((l) => l.id)).toEqual([1, 2, 3]);
  });

  it("caps an all-day conversation, keeping the most recent", () => {
    const many = Array.from({ length: TRANSCRIPT_MAX + 25 }, (_, i) => line(i + 1));
    const t = mergeTranscript([], many);
    expect(t).toHaveLength(TRANSCRIPT_MAX);
    expect(t[t.length - 1].id).toBe(TRANSCRIPT_MAX + 25);
  });

  it("does not mutate what it was handed", () => {
    const prev = mergeTranscript([], [line(1)]);
    const copy = [...prev];
    mergeTranscript(prev, [line(2)]);
    expect(prev).toEqual(copy);
  });
});

describe("unreadSince", () => {
  it("counts only what arrived after the reader last looked", () => {
    const t = mergeTranscript([], [line(1), line(2), line(3)]);
    expect(unreadSince(t, 1)).toBe(2);
  });

  it("is zero once everything has been read", () => {
    const t = mergeTranscript([], [line(1), line(2)]);
    expect(unreadSince(t, 2)).toBe(0);
  });

  it("leaves no phantom badge on an empty room", () => {
    expect(unreadSince([], 0)).toBe(0);
  });
});

describe("transcriptClock", () => {
  it("zero-pads, so rows line up in a column", () => {
    const at = new Date(2026, 7, 18, 4, 5).getTime();
    expect(transcriptClock(at)).toBe("04:05");
  });
});
