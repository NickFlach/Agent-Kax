/**
 * What was said in this room, kept rather than thrown away.
 *
 * Speech reached the browser only as a bubble over a speaker's head, and
 * `usePresence` filtered its own state to `BUBBLE_MS` — eight seconds — so a
 * line that had been on screen for nine seconds was gone from the client
 * entirely. Nothing kept it.
 *
 * That is fine for a passing "hello" on a busy street and useless for a room
 * where two agents think out loud every few minutes. Nick, standing in
 * Flaukowski's Cafe with three residents in it: "I can talk but I don't see
 * them respond. Every now and then I see their words but not often." Eight
 * seconds of visibility per exchange, and only if he happened to be facing the
 * right way.
 *
 * The server was never the problem. `heard()` is cursor-based, not
 * destructive: lines live `CHAT_TTL_MS` (two minutes), the room keeps its last
 * 60, and every listener reads from its own `sinceId`. An agent draining its
 * `/city/look` cannot take a line away from anybody else. The browser was
 * simply dropping what it had already been given.
 *
 * So bubbles keep their eight seconds — they are a glance, and a permanent one
 * would be clutter — and the transcript keeps the conversation.
 */

export interface TranscriptLine {
  id: number;
  principal: string;
  name: string;
  text: string;
  at: number;
}

/**
 * Long enough to scroll back through a conversation, short enough that an
 * afternoon in a busy room cannot grow without bound.
 */
export const TRANSCRIPT_MAX = 200;

/**
 * Fold newly heard lines into the transcript.
 *
 * RETURNS THE SAME ARRAY when nothing is new, which is not a micro-optimisation:
 * the presence beat runs every 900 ms, and a fresh array identity on every one
 * of them would re-render the pane roughly seventy times a minute in a silent
 * room and fight anyone trying to scroll back through it.
 *
 * Dedupes by id because `sinceId` is not the only path in — a visibility change
 * fires an immediate beat that can overlap the scheduled one, and both may
 * carry the same line.
 */
export function mergeTranscript(
  prev: readonly TranscriptLine[],
  fresh: readonly TranscriptLine[],
  max: number = TRANSCRIPT_MAX,
): TranscriptLine[] {
  if (!fresh.length) return prev as TranscriptLine[];

  const seen = new Set(prev.map((l) => l.id));
  const added = fresh.filter((l) => !seen.has(l.id));
  if (!added.length) return prev as TranscriptLine[];

  // Sort by id, not by `at`: ids are the server's own order, while two lines
  // spoken in the same millisecond would tie on a timestamp.
  return [...prev, ...added].sort((a, b) => a.id - b.id).slice(-max);
}

/** Clock for a transcript row — a conversation wants when, not how long ago. */
export function transcriptClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * How many lines arrived that the reader has not seen.
 *
 * Counted from the last id they had open rather than from a running total, so
 * closing and reopening the pane cannot leave a phantom badge behind.
 */
export function unreadSince(transcript: readonly TranscriptLine[], lastReadId: number): number {
  return transcript.reduce((n, l) => (l.id > lastReadId ? n + 1 : n), 0);
}
