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

describe("collapsing a family of rooms", () => {
  // The live shape: twelve residence rooms out of nineteen, all labelled
  // "Standing Wave Residences — floor N". At the board's width they truncate
  // to the same string, so a visitor read eleven identical lines.
  const TOWER: BoardRoom[] = [
    room("residences:L", "Standing Wave Residences — lobby"),
    ...Array.from({ length: 10 }, (_, i) =>
      room(`residences:${i + 2}`, `Standing Wave Residences — floor ${i + 2}`, i === 3 ? 2 : 0),
    ),
    room("residences:PH", "Standing Wave Residences — the penthouse", 1),
  ];

  it("turns a tower into one line", () => {
    const b = layoutBoard([...TODAY, ...TOWER]);
    const residence = b.lines.filter((l) => l.id.startsWith("residences"));
    expect(residence, "the tower still takes a line per floor").toHaveLength(1);
    // Assert the property, not the exact cut — where fitLabel breaks is its
    // own tests' business, and duplicating it here would make this fail for a
    // reason that has nothing to do with collapsing.
    expect(residence[0]!.text.startsWith("Standing Wave")).toBe(true);
    expect(residence[0]!.text).not.toMatch(/floor|lobby|penthouse/i);
  });

  it("adds the building up rather than showing one floor", () => {
    // 2 on a floor + 1 in the penthouse. A tally of 2 would be the largest
    // floor, and would mean the sign under-reports the building.
    const b = layoutBoard([...TODAY, ...TOWER]);
    const residence = b.lines.find((l) => l.id.startsWith("residences"))!;
    expect(residence.here).toBe(3);
    expect(residence.rooms).toBe(TOWER.length);
  });

  it("stops the tower from crowding the rest of the city off the sign", () => {
    // The live numbers: 19 rooms, 12 of them one building. Before collapsing,
    // the board showed 12 lines and hid 7 real destinations behind them.
    const before = TODAY.length + TOWER.length;
    const b = layoutBoard([...TODAY, ...TOWER]);
    expect(before).toBeGreaterThan(MAX_BOARD_LINES);
    expect(b.overflow, "still overflowing after the collapse").toBe(0);
    for (const r of TODAY) {
      expect(b.lines.some((l) => l.id === r.id), `${r.label} was pushed off the board`).toBe(true);
    }
  });

  it("leaves a lone family member alone", () => {
    // One room in a family is not a building worth summarising.
    const b = layoutBoard([...TODAY, room("annexe:1", "The Annexe — room one", 4)]);
    const line = b.lines.find((l) => l.id.startsWith("annexe"))!;
    expect(line.here).toBe(4);
    expect(line.rooms).toBeUndefined();
  });

  it("does not collapse rooms that merely share a word", () => {
    // Only the id prefix groups. Two unrelated rooms with similar names must
    // stay two lines, or the sign starts inventing buildings.
    const b = layoutBoard([room("cafe", "Flaukowski’s Cafe"), room("arcade", "The Arcade")]);
    expect(b.lines).toHaveLength(2);
  });
});
