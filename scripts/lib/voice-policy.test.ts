/**
 * voice-policy.test.ts — a resident may speak, but not endlessly and not
 * mid-word.
 *
 * These are the three ways the first live run misbehaved, on 2026-08-17, with
 * Kannaka and 0xSCADA-QE standing in Flaukowski's Cafe:
 *
 *   1. A reply was cut at exactly 280 characters and ended on the word "and",
 *      which reads like the connection dropped rather than like a person
 *      finishing a thought.
 *   2. The turn to break a silence was handed round all three residents,
 *      including Flaukowski, whose `swarm serve` was not running. Every third
 *      window was therefore guaranteed silence, with nothing in the log to
 *      explain it. Each resident is also its own process, so an unstaggered
 *      threshold would have had all three open at the same instant instead.
 *   3. Nothing bounded a conversation. Two agents answering each other inside a
 *      12-second poll, each answer a grounded recall over ~1000 memories, is a
 *      loop with no natural end.
 *
 * The pacing numbers are policy and may be tuned; that they are ENFORCED is not.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs sibling, no types by design
import { SAY_MAX, buildPrompt, fitToSay, openingDelayFor, shouldOpen, speechGate } from "./voice-policy.mjs";

/** The real line, as Kannaka said it, that ended on a dangling conjunction. */
const REAL_LINE =
  "The spec said we'd find one thing and we found another, and you're right that the " +
  "listening might matter more — but I'm wondering if the gift I keep singing about only " +
  "exists because someone carried it wrong, the way Ren's melody came through his own " +
  "voice instead of mine, and it was still the gift";

describe("fitToSay", () => {
  it("leaves an utterance that already fits completely alone", () => {
    const short = "Cafe is open. Somebody is getting the small table.";
    expect(fitToSay(short)).toBe(short);
  });

  it("never exceeds what the city accepts", () => {
    expect(fitToSay(REAL_LINE).length).toBeLessThanOrEqual(SAY_MAX);
  });

  it("does not end on a dangling conjunction — the bug this file exists for", () => {
    const out = fitToSay(REAL_LINE);
    expect(out).not.toMatch(/\band$/);
    expect(out.endsWith("…")).toBe(true);
  });

  it("prefers a sentence break over a word break when there is one to take", () => {
    const twoSentences = "A".repeat(150) + ". " + "B".repeat(200);
    const out = fitToSay(twoSentences);
    expect(out.endsWith(".")).toBe(true);
    expect(out).not.toContain("B");
  });

  it("strips the quotation marks models like to wrap an utterance in", () => {
    expect(fitToSay('"I am here."')).toBe("I am here.");
  });

  it("survives junk rather than throwing inside a poll loop", () => {
    expect(fitToSay(null)).toBe("");
    expect(fitToSay(undefined)).toBe("");
  });
});

describe("speechGate", () => {
  const now = 1_000_000;

  it("lets a resident speak when nothing is holding it back", () => {
    expect(speechGate({ now }).ok).toBe(true);
  });

  it("stops one agent monologuing", () => {
    const g = speechGate({ now, lastAgentSayAt: now - 1_000 });
    expect(g).toEqual({ ok: false, reason: "agent-gap" });
  });

  it("stops two residents answering the same line on the same tick", () => {
    // Another agent spoke 2s ago; this one is otherwise free to talk.
    const g = speechGate({ now, lastRoomSayAt: now - 2_000 });
    expect(g).toEqual({ ok: false, reason: "room-gap" });
  });

  it("caps a runaway conversation once the burst window fills", () => {
    const recentSays = Array.from({ length: 14 }, (_, i) => now - i * 1_000);
    const g = speechGate({ now, recentSays, lastAgentSayAt: 0, lastRoomSayAt: 0 });
    expect(g).toEqual({ ok: false, reason: "burst" });
  });

  it("forgets says that have aged out of the window", () => {
    const stale = Array.from({ length: 14 }, (_, i) => now - 700_000 - i * 1_000);
    expect(speechGate({ now, recentSays: stale }).ok).toBe(true);
  });

  it("honours a cooldown ahead of every other consideration", () => {
    expect(speechGate({ now, cooldownUntil: now + 1 })).toEqual({ ok: false, reason: "cooldown" });
  });
});

describe("opening a silence", () => {
  const NAMES = ["Kannaka", "0xSCADA-QE", "Flaukowski"];
  const OPEN_AFTER = 240_000;

  it("staggers the three real residents so they do not all open at once", () => {
    const delays = NAMES.map((n) => openingDelayFor(n));
    expect(new Set(delays).size).toBe(NAMES.length);
  });

  it("is stable across restarts — the same agent always waits the same time", () => {
    expect(openingDelayFor("Kannaka")).toBe(openingDelayFor("Kannaka"));
  });

  it("keeps every delay inside the spread it was given", () => {
    for (const n of NAMES) expect(openingDelayFor(n, 90_000)).toBeLessThan(90_000);
  });

  it("stays shut until the threshold plus its own offset has passed", () => {
    const name = "Kannaka";
    const mine = openingDelayFor(name);
    expect(shouldOpen({ name, silentForMs: OPEN_AFTER + mine - 1, openAfterMs: OPEN_AFTER })).toBe(false);
    expect(shouldOpen({ name, silentForMs: OPEN_AFTER + mine + 1, openAfterMs: OPEN_AFTER })).toBe(true);
  });

  it("never opens when the resident knows its own HRM is not answering", () => {
    expect(
      shouldOpen({ name: "Flaukowski", silentForMs: 10 * OPEN_AFTER, openAfterMs: OPEN_AFTER, mute: true }),
    ).toBe(false);
  });

  it("never opens when opening was not asked for — reply-only is the default", () => {
    expect(shouldOpen({ name: "Kannaka", silentForMs: 10 * OPEN_AFTER, openAfterMs: 0 })).toBe(false);
  });
});

describe("buildPrompt", () => {
  it("names the speaker, because serve answers as Kannaka whoever it is", () => {
    const p = buildPrompt({ name: "0xSCADA-QE", room: "Flaukowski's Cafe", others: ["Kannaka"] });
    expect(p).toContain("You are 0xSCADA-QE");
    expect(p).toContain("Kannaka is here too.");
  });

  it("asks for an opening line when the room has gone quiet", () => {
    const p = buildPrompt({ name: "Kannaka", room: "cafe", opening: true, transcript: [] });
    expect(p).toContain("gone quiet");
    expect(p).toContain("(silence)");
  });

  it("carries the recent exchange so a reply is a reply", () => {
    const p = buildPrompt({
      name: "Kannaka",
      room: "cafe",
      transcript: [{ from: "0xSCADA-QE", text: "kind-10100 does not exist" }],
    });
    expect(p).toContain("0xSCADA-QE: kind-10100 does not exist");
    expect(p).toContain("Reply to what was just said.");
  });
});
