/**
 * directory-board.test.ts — the sign must read at six rooms and at forty-eight.
 *
 * The city had no directory at all: a grep for kiosk, signpost, wayfind or
 * city map across the frontend returned nothing, and the only room list was
 * `sr-only focus-within:not-sr-only` — an accessibility affordance, not a map.
 * The player spawned facing 157 units of street with the anchors 110 units
 * away and nothing to read.
 *
 * The layout is tested apart from the geometry because its failure mode is
 * invisible in a screenshot taken today: a board sized for six rooms that
 * overflows into the pavement at forty-eight, or one sized for forty-eight
 * standing half empty at six. Both only bite after the city grows, which is
 * exactly when nobody is checking the sign.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_BOARD_LINES,
  MAX_LABEL_CHARS,
  fitLabel,
  layoutBoard,
  overflowLine,
  type BoardRoom,
} from "./directory-board";

const room = (id: string, label: string, here = 0): BoardRoom => ({ id, label, here });

/** The city as it stands today. */
const TODAY: BoardRoom[] = [
  room("city", "The street", 1),
  room("cafe", "Flaukowski's Cafe"),
  room("arcade", "The Arcade"),
  room("bank", "Resonance Trust"),
  room("joinery", "The Joinery"),
  room("gs", "Ghost Signals Trading Floor"),
];

describe("board layout", () => {
  it("shows every room when there are few", () => {
    const b = layoutBoard(TODAY);
    expect(b.lines).toHaveLength(TODAY.length);
    expect(b.overflow).toBe(0);
  });

  it("grows the board to its content rather than to a guess", () => {
    // Six rooms get a small sign; forty-eight get a taller one. A fixed height
    // is wrong in one direction or the other and looks deliberate either way.
    const small = layoutBoard(TODAY);
    const big = layoutBoard(Array.from({ length: 48 }, (_, i) => room(`r${i}`, `Room ${i}`)));
    expect(big.height).toBeGreaterThan(small.height);
    // …but never so tall it leaves the post. The board caps its lines.
    expect(big.lines.length).toBeLessThanOrEqual(MAX_BOARD_LINES);
    expect(big.height).toBeLessThan(5);
  });

  it("counts what it could not show instead of dropping it silently", () => {
    // A sign that lists twelve of forty-eight rooms and says nothing about the
    // rest is a sign that lies by omission.
    const b = layoutBoard(Array.from({ length: 48 }, (_, i) => room(`r${i}`, `Room ${i}`)));
    expect(b.overflow).toBe(48 - b.lines.length);
    expect(overflowLine(b.overflow)).toContain(String(b.overflow));
    expect(overflowLine(1)).toBe("+1 more room");
  });

  it("puts busy rooms where they can be seen from the street", () => {
    const b = layoutBoard([
      room("empty-a", "Aardvark Hall"),
      room("busy", "Somewhere Busy", 5),
      room("empty-z", "Zebra Room"),
    ]);
    expect(b.lines[0]!.id).toBe("busy");
    // Ties fall back to the label, so an all-empty city does not reorder its
    // own sign between renders — which would read as flicker.
    expect(b.lines.slice(1).map((l) => l.id)).toEqual(["empty-a", "empty-z"]);
  });

  it("is stable when nothing is happening", () => {
    const quiet = TODAY.map((r) => ({ ...r, here: 0 }));
    const first = layoutBoard(quiet).lines.map((l) => l.id);
    const shuffled = layoutBoard([...quiet].reverse()).lines.map((l) => l.id);
    expect(shuffled).toEqual(first);
  });

  it("survives an empty city without pretending it is full", () => {
    const b = layoutBoard([]);
    expect(b.lines).toEqual([]);
    expect(b.overflow).toBe(0);
    // Still a board, not a zero-height sliver.
    expect(b.height).toBeGreaterThan(1);
  });
});

describe("label fitting", () => {
  it("leaves a short label alone", () => {
    expect(fitLabel("The Arcade")).toBe("The Arcade");
  });

  it("breaks on a word rather than mid-syllable", () => {
    // "Ghost Signals Trading Fl" reads as damage. "Ghost Signals…" reads as a
    // sign. The real longest label in the city is the one being cut here.
    const got = fitLabel("Ghost Signals Trading Floor");
    expect(got.length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
    expect(got.endsWith("…")).toBe(true);
    expect(got).not.toMatch(/\s…$/); // no space left dangling before the ellipsis
    expect("Ghost Signals Trading Floor".startsWith(got.slice(0, -1))).toBe(true);
  });

  it("still cuts a single long word", () => {
    // No space to break on. Shrinking to nothing would be worse than a cut.
    const got = fitLabel("Supercalifragilisticexpialidocious");
    expect(got.length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
    expect(got.endsWith("…")).toBe(true);
  });

  it("normalises whitespace so a stray newline cannot break the row", () => {
    expect(fitLabel("  The   Arcade \n")).toBe("The Arcade");
  });

  it("never returns more than it was asked for, for any room name", () => {
    const names = [...TODAY.map((r) => r.label), "A", "", "x".repeat(200), "two words here that go on"];
    for (const n of names) {
      expect(fitLabel(n).length, `"${n}"`).toBeLessThanOrEqual(MAX_LABEL_CHARS);
    }
  });
});
