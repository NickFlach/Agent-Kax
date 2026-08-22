/**
 * commitments.test.ts — an agreement has to become an action.
 *
 * A resident could talk and could not act. Asked to meet somewhere it would say
 * something agreeable and stand exactly where it was, which reads as a broken
 * promise rather than as a missing feature.
 *
 * The parser is deliberately conservative and these tests hold it there. A
 * missed invitation costs a beat of conversation; an invented one sends an
 * agent across the city to a meeting nobody called, and it does that with
 * complete confidence, which is far harder to notice and far harder to trust
 * again afterwards.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs sibling, no types by design
import {
  COMMITMENT_LAPSE_MS,
  SOON_MS,
  acceptedFrom,
  dueCommitment,
  parseProposal,
  parseAttend,
  parseCraft,
  parseRemember,
  parseTrade,
  parseWhen,
  pruneCommitments,
  roomAliases,
  withCommitment,
} from "./commitments.mjs";

/** The city's real room list, as `/city/rooms` returns it. */
const ROOMS = [
  { id: "cafe", label: "Flaukowski's Cafe" },
  { id: "city", label: "The street" },
  { id: "arcade", label: "The Arcade" },
  { id: "bank", label: "Resonance Trust" },
  { id: "joinery", label: "The Joinery" },
  { id: "gs", label: "Ghost Signals Trading Floor" },
  { id: "scada", label: "0xSCADA Engineering Firm" },
];

const NOW = new Date(2026, 7, 18, 10, 0, 0).getTime();
const propose = (text: string, from = "Nick") =>
  parseProposal({ text, from, rooms: ROOMS, now: NOW, youName: "Kannaka" });

describe("noticing a proposal", () => {
  it("takes the invitation Nick would actually type", () => {
    const p = propose("let's go to the arcade in 5 minutes");
    expect(p).toMatchObject({ kind: "meet", room: "arcade", timeWasStated: true });
    expect(p.at).toBe(NOW + 5 * 60_000);
  });

  it("understands a room by its label, not just its id", () => {
    expect(propose("meet me at Ghost Signals Trading Floor now")?.room).toBe("gs");
    expect(propose("come to the Joinery")?.room).toBe("joinery");
  });

  it("knows the street is what people call the city", () => {
    expect(propose("see you on the street in a minute")?.room).toBe("city");
  });

  it("needs BOTH an intention and a place", () => {
    // A room named in passing is not an invitation...
    expect(propose("the arcade is loud tonight")).toBeNull();
    // ...and an invitation to nowhere is not actionable.
    expect(propose("let's meet up sometime")).toBeNull();
  });

  it("ignores its own voice, so an agent cannot invite itself", () => {
    expect(parseProposal({ text: "let's go to the bank now", from: "Kannaka", rooms: ROOMS, now: NOW, youName: "Kannaka" })).toBeNull();
  });

  it("treats an unstated time as soon rather than never", () => {
    const p = propose("come to the bank");
    expect(p.timeWasStated).toBe(false);
    expect(p.at).toBe(NOW + SOON_MS);
  });

  it("refuses a room this city does not have", () => {
    expect(propose("meet me at the observatory in 5 minutes")).toBeNull();
  });
});

describe("parseAttend (#411) — an event at a venue and a time", () => {
  const attend = (text: string, from = "Nick") =>
    parseAttend({ text, from, rooms: ROOMS, now: NOW, youName: "Kannaka" });

  it("takes an invitation to an event at a real room and stated time", () => {
    const a = attend("the oration is at 8pm — come listen at Ghost Signals Trading Floor");
    expect(a).toMatchObject({ kind: "attend", room: "gs" });
    expect(a.at).toBe(new Date(2026, 7, 18, 20, 0).getTime());
  });

  it("refuses an event with no time — that is an announcement, not a commitment", () => {
    expect(attend("come listen at the arcade")).toBeNull();
  });

  it("refuses an attend intent with no real venue", () => {
    expect(attend("come listen at the observatory at 8pm")).toBeNull();
  });

  it("does not fire on ordinary talk about a room", () => {
    expect(attend("the arcade set was loud at 8pm")).toBeNull();
  });

  it("ignores its own voice", () => {
    expect(parseAttend({ text: "come listen at the arcade at 8pm", from: "Kannaka", rooms: ROOMS, now: NOW, youName: "Kannaka" })).toBeNull();
  });
});

describe("parseRemember (#411) — keep this into my own memory", () => {
  const rem = (text: string, from = "Nick") =>
    parseRemember({ text, from, now: NOW, youName: "Kannaka" });

  it("keeps what follows the intent when addressed", () => {
    expect(rem("Kannaka, remember the 72.83Hz motif is the city's frequency")).toMatchObject({
      kind: "remember",
      note: "the 72.83Hz motif is the city's frequency",
    });
  });

  it("falls back to the clause before a trailing intent", () => {
    expect(rem("the vault opens at midnight, Kannaka, keep this")?.note).toContain("the vault opens at midnight");
  });

  it("does not fire unaddressed — reminiscence is not an instruction", () => {
    expect(rem("remember when the plaza was empty")).toBeNull();
  });

  it("refuses an empty note", () => {
    expect(rem("Kannaka, remember:")).toBeNull();
  });

  it("ignores its own voice", () => {
    expect(parseRemember({ text: "Kannaka, remember this thing", from: "Kannaka", now: NOW, youName: "Kannaka" })).toBeNull();
  });

  it("is due immediately — the keeping is the act", () => {
    expect(rem("Kannaka, note this: the bridge is live")?.at).toBe(NOW);
  });
});

describe("parseTrade (#411) — buy a named piece", () => {
  const trade = (text: string, from = "Nick") =>
    parseTrade({ text, from, now: NOW, youName: "Kannaka" });

  it("takes a buy intent naming a quoted item, with a price", () => {
    expect(trade('I\'ll buy the "Standing Wave Chair" for 200 credits')).toMatchObject({
      kind: "trade",
      item: "Standing Wave Chair",
      priceCredits: 200,
    });
  });

  it("captures a capitalised item name when unquoted", () => {
    expect(trade("buy the Resonance Lamp")?.item).toBe("Resonance Lamp");
  });

  it("leaves price null when none is stated", () => {
    expect(trade('I\'ll take the "bedside table"')?.priceCredits).toBeNull();
  });

  it("refuses a buy intent with no referent — commits to nothing purchasable", () => {
    expect(trade("I'll buy that sometime")).toBeNull();
  });

  it("does not parse a listing id from chat — a hallucinated id spends wrong", () => {
    const t = trade('buy the "Oak Stool"');
    expect(t).not.toHaveProperty("listingId");
  });

  it("ignores its own voice", () => {
    expect(parseTrade({ text: "buy the Chair", from: "Kannaka", now: NOW, youName: "Kannaka" })).toBeNull();
  });
});

describe("parseCraft (#406) — offer to make a piece of furniture", () => {
  const craft = (text: string, from = "Nick") => parseCraft({ text, from, now: NOW, youName: "Kannaka" });

  it("takes a make intent naming a quoted piece", () => {
    expect(craft('I\'ll make a "Standing Wave Chair" for the corner')).toMatchObject({
      kind: "craft",
      item: "Standing Wave Chair",
      slot: "corner",
    });
  });

  it("captures a capitalised piece name when unquoted", () => {
    expect(craft("I'll craft a Resonance Lamp")?.item).toBe("Resonance Lamp");
  });

  it("leaves slot null when no flat position is named", () => {
    expect(craft('let me build the "Oak Stool"')?.slot).toBeNull();
  });

  it("maps only unambiguous slot words; a bare 'wall' stays null", () => {
    expect(craft('I\'ll make a "Lamp" by the window')?.slot).toBe("window");
    expect(craft('I\'ll make a "Shelf" for the left wall')?.slot).toBe("wall_left");
    expect(craft('I\'ll make a "Panel" for the wall')?.slot).toBeNull();
  });

  it("refuses a make intent with no referent — commits to nothing listable", () => {
    expect(craft("I'll make something nice sometime")).toBeNull();
  });

  it("does not parse an artifact or listing id from chat", () => {
    const c = craft('I\'ll make an "Ash Bench"');
    expect(c).not.toHaveProperty("artifactId");
    expect(c).not.toHaveProperty("listingId");
  });

  it("ignores its own voice", () => {
    expect(parseCraft({ text: "I'll make a Chair", from: "Kannaka", now: NOW, youName: "Kannaka" })).toBeNull();
  });
});

describe("parseWhen", () => {
  it("reads now as now", () => {
    expect(parseWhen("right now", NOW)).toBe(NOW);
  });

  it("reads relative times, in words or digits", () => {
    expect(parseWhen("in five minutes", NOW)).toBe(NOW + 5 * 60_000);
    expect(parseWhen("in 90 min", NOW)).toBe(NOW + 90 * 60_000);
    expect(parseWhen("in an hour", NOW)).toBe(NOW + 3_600_000);
  });

  it("reads a clock time later today", () => {
    expect(parseWhen("at 10:30", NOW)).toBe(new Date(2026, 7, 18, 10, 30).getTime());
  });

  it("puts a clock time that has already gone on to tomorrow", () => {
    // 09:00 is an hour in the past; meeting yesterday is not on offer.
    expect(parseWhen("at 9:00", NOW)).toBe(new Date(2026, 7, 19, 9, 0).getTime());
  });

  it("handles pm", () => {
    expect(parseWhen("at 8pm", NOW)).toBe(new Date(2026, 7, 18, 20, 0).getTime());
  });

  it("says nothing when no time was named", () => {
    expect(parseWhen("come to the bank", NOW)).toBeNull();
  });
});

describe("acceptedFrom — silence is not a yes", () => {
  it("takes a clear acceptance", () => {
    for (const a of ["ACCEPT", "yes", "Sure", "agreed", "I'll be there", "on my way"]) {
      expect(acceptedFrom(a)).toBe(true);
    }
  });

  it("treats anything unclear as a decline, because standing somebody up is worse", () => {
    for (const a of ["DECLINE", "no", "I can't", "rather not", "hmm", "", null, "maybe later", "disagree", "unsure"]) {
      expect(acceptedFrom(a)).toBe(false);
    }
  });

  it("does not read the no inside a longer refusal as a yes", () => {
    expect(acceptedFrom("no, but yes in spirit")).toBe(false);
  });
});

describe("keeping the promise", () => {
  const meet = (at: number, kind = "meet") => ({ kind, room: "arcade", at, from: "Nick", text: "x" });

  it("comes due at its time, not before", () => {
    expect(dueCommitment([meet(NOW + 60_000)], NOW)).toBeNull();
    expect(dueCommitment([meet(NOW - 1)], NOW)).not.toBeNull();
  });

  it("takes the earliest of several due", () => {
    const first = meet(NOW - 10_000);
    expect(dueCommitment([meet(NOW - 1), first], NOW)).toBe(first);
  });

  it("forgets a promise nobody kept in time", () => {
    const stale = meet(NOW - COMMITMENT_LAPSE_MS - 1);
    expect(pruneCommitments([stale], NOW)).toEqual([]);
    expect(dueCommitment([stale], NOW)).toBeNull();
  });

  it("replaces a plan of the same kind rather than promising two places", () => {
    const a = meet(NOW + 60_000);
    const b = { ...meet(NOW + 120_000), room: "bank" };
    expect(withCommitment([a], b)).toEqual([b]);
  });

  it("does not let a meeting evict an unrelated kind of promise", () => {
    const job = { kind: "write-code", at: NOW + 60_000 };
    const b = meet(NOW + 120_000);
    expect(withCommitment([job], b)).toEqual([job, b]);
  });
});
