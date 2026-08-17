/**
 * What a directory board says, and how it fits on the board.
 *
 * The player spawns at {x:0, z:18} facing 157 units of street with no sign
 * anywhere, and the anchors are 110 units away. A grep for kiosk, signpost,
 * wayfind, directory or city map across the whole frontend returns nothing —
 * the only directory in the city is `sr-only focus-within:not-sr-only`, an
 * accessibility affordance rather than a map. A visitor's first question is
 * "what is here", and the city had no answer you could read by looking.
 *
 * The layout maths lives here, apart from the geometry, because it is the part
 * that can be wrong in a way a screenshot would not show: a board that reads
 * perfectly at today's six rooms and overflows into the pavement at forty-
 * eight, or the reverse — one built for forty-eight and half empty at six.
 * That is the kind of thing that only bites after the city grows, which is
 * exactly when nobody is looking at the sign.
 */

export interface BoardRoom {
  id: string;
  label: string;
  here: number;
}

export interface BoardLine {
  id: string;
  /** What the sign reads. Already truncated to fit. */
  text: string;
  /** How many are in there now, for the tally on the right. */
  here: number;
}

export interface BoardLayout {
  lines: BoardLine[];
  /** Rooms that did not fit, so the board can say so rather than lie. */
  overflow: number;
  /** Board height in metres, grown to fit its lines. */
  height: number;
  /** Y of the first line, measured from the board's centre. */
  firstLineY: number;
}

/** How many rooms one board will show before it starts counting the rest. */
export const MAX_BOARD_LINES = 12;
/** Characters a label may take before it is cut. */
export const MAX_LABEL_CHARS = 22;

const LINE_HEIGHT = 0.26;
const HEADER_SPACE = 0.62;
const FOOTER_SPACE = 0.28;

/**
 * Shorten a label to fit the board, breaking on a word where it can.
 *
 * A hard slice mid-word reads as damage rather than as abbreviation —
 * "Ghost Signals Trading Fl" looks like a bug, "Ghost Signals…" looks like a
 * sign. Only breaks on a space that leaves most of the width used, so a long
 * first word still gets cut rather than shrinking the line to nothing.
 */
export function fitLabel(label: string, max = MAX_LABEL_CHARS): string {
  const clean = label.trim().replace(/\s+/g, " ");
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * Lay a room list out on a board.
 *
 * Sorted by occupancy first so a busy room is visible from the street, then by
 * label so the order is stable when everything is empty — which is most of the
 * time, and the case where an unstable order would make the sign appear to
 * flicker between renders.
 */
export function layoutBoard(rooms: readonly BoardRoom[], maxLines = MAX_BOARD_LINES): BoardLayout {
  const ordered = [...rooms].sort((a, b) => b.here - a.here || a.label.localeCompare(b.label));
  const shown = ordered.slice(0, maxLines);
  const overflow = Math.max(0, ordered.length - shown.length);

  const lines: BoardLine[] = shown.map((r) => ({
    id: r.id,
    text: fitLabel(r.label),
    here: r.here,
  }));

  // The board grows to its content rather than being sized for a guess. Six
  // rooms get a small sign; forty-eight get a tall one that still ends above
  // the pavement.
  const rows = lines.length + (overflow > 0 ? 1 : 0);
  const height = Math.max(1.1, HEADER_SPACE + rows * LINE_HEIGHT + FOOTER_SPACE);
  const firstLineY = height / 2 - HEADER_SPACE;

  return { lines, overflow, height, firstLineY };
}

/** The line a board shows when there is more than it can hold. */
export function overflowLine(overflow: number): string {
  return overflow === 1 ? "+1 more room" : `+${overflow} more rooms`;
}
