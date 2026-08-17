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
  /** Set when this entry stands for a collapsed family of rooms. */
  rooms?: number;
}

export interface BoardLine {
  id: string;
  /** What the sign reads. Already truncated to fit. */
  text: string;
  /** How many are in there now, for the tally on the right. */
  here: number;
  /** How many rooms this line stands for, when it collapses a family. */
  rooms?: number;
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
 * Collapse a family of rooms into the building that contains them.
 *
 * The residences publish twelve rooms — a lobby, ten floors and the penthouse
 * — all labelled "Standing Wave Residences — floor N". At the board's width
 * they truncate to the same string, so a visitor read eleven identical lines
 * and learned nothing from any of them. Eleven of the city's nineteen rooms
 * were one building, spending most of the sign on itself.
 *
 * A person at the street mouth wants to know the tower is there. Which of its
 * landings currently has somebody on it is a question for somebody already
 * inside, and the lift answers it better than a sign at the door.
 *
 * Occupancy sums across the family, so the tally means "people in that
 * building" rather than "people on whichever floor happened to sort first".
 */
export function collapseFamilies(rooms: readonly BoardRoom[]): BoardRoom[] {
  const families = new Map<string, { label: string; here: number; count: number }>();
  const singles: BoardRoom[] = [];

  for (const r of rooms) {
    const sep = r.id.indexOf(":");
    if (sep < 0) {
      singles.push(r);
      continue;
    }
    const key = r.id.slice(0, sep);
    // The shared part of the label, before whatever distinguishes members.
    // Falls back to the id when a family shares no prefix — a naming problem,
    // not a reason to print nothing.
    const label = r.label.split("—")[0]?.trim() || key;
    const prev = families.get(key);
    families.set(key, {
      label: prev?.label ?? label,
      here: (prev?.here ?? 0) + r.here,
      count: (prev?.count ?? 0) + 1,
    });
  }

  const collapsed: BoardRoom[] = [...singles];
  for (const [key, f] of families) {
    collapsed.push({ id: key, label: f.label, here: f.here, rooms: f.count });
  }
  return collapsed;
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
  // Families collapse before anything is measured, so the count that decides
  // overflow is the count a visitor will actually read.
  const ordered = collapseFamilies(rooms).sort((a, b) => b.here - a.here || a.label.localeCompare(b.label));
  const shown = ordered.slice(0, maxLines);
  const overflow = Math.max(0, ordered.length - shown.length);

  const lines: BoardLine[] = shown.map((r) => ({
    id: r.id,
    text: fitLabel(r.label),
    here: r.here,
    // Only when it stands for more than itself — a lone room is not a
    // building worth summarising, and "1 fl" would read as noise.
    ...(r.rooms && r.rooms > 1 ? { rooms: r.rooms } : {}),
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
