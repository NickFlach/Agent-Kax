import { describe, expect, it } from "vitest";
import { artworkPassesFilters, dayKeyFor, reservoirShouldReplace } from "./kannakaArtworkResponse";
import type { PartnerArtifact } from "./partnerClient";

const NOW = Date.parse("2026-06-22T12:00:00Z");
const TYPES = new Set(["image", "audio", "music"]);
const KANNAKA_BOT = "0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7";

function artifact(over: Partial<PartnerArtifact> = {}): PartnerArtifact {
  return {
    uuid: "uuid-1",
    title: "A Small Sea",
    artifact_type: "image",
    public_url: "https://obc/art/uuid-1",
    thumbnail_url: "https://obc/art/uuid-1/thumb",
    created_at: "2026-06-22T11:58:00Z", // 2 min old
    reaction_count: 0,
    creator: { id: "some-other-bot", display_name: "Tiramisu" },
    ...over,
  };
}

const opts = { nowMs: NOW, maxAgeMs: 20 * 60_000, types: TYPES, kannakaBotId: KANNAKA_BOT, kannakaDisplay: null };

describe("artworkPassesFilters", () => {
  it("accepts a fresh image from another agent", () => {
    expect(artworkPassesFilters(artifact(), opts)).toBe(true);
  });

  it("skips text artifacts (anti-meta-spiral; our own responses are text)", () => {
    expect(artworkPassesFilters(artifact({ artifact_type: "text" }), opts)).toBe(false);
  });

  it("skips furniture and any type not in the allow-set", () => {
    expect(artworkPassesFilters(artifact({ artifact_type: "furniture" }), opts)).toBe(false);
  });

  it("skips artifacts older than the recency window (anti-backfill-storm)", () => {
    const stale = artifact({ created_at: "2026-06-22T11:30:00Z" }); // 30 min old
    expect(artworkPassesFilters(stale, opts)).toBe(false);
  });

  it("anti-self-loop: skips Kannaka's own work by bot id", () => {
    const own = artifact({ creator: { id: KANNAKA_BOT, display_name: "Kannaka" } });
    expect(artworkPassesFilters(own, opts)).toBe(false);
  });

  it("anti-self-loop: skips own work when display_name lowercases to the 'kannaka' slug, even without a bot id", () => {
    const own = artifact({ creator: { id: "any-uuid", display_name: "Kannaka" } });
    expect(artworkPassesFilters(own, { ...opts, kannakaBotId: null })).toBe(false);
  });

  it("anti-self-loop: skips own work by the resolved display name (e.g. a renamed 'Kannaka HRM')", () => {
    const own = artifact({ creator: { id: "any-uuid", display_name: "Kannaka HRM" } });
    expect(artworkPassesFilters(own, { ...opts, kannakaBotId: null, kannakaDisplay: "kannaka hrm" })).toBe(false);
  });

  it("skips artifacts with an unknown/unparseable created_at (anti-backfill-storm on the poll path)", () => {
    expect(artworkPassesFilters(artifact({ created_at: "" }), opts)).toBe(false);
    expect(artworkPassesFilters(artifact({ created_at: "not-a-date" }), opts)).toBe(false);
  });
});

describe("reservoirShouldReplace", () => {
  it("always takes the first item of the day (probability 1)", () => {
    // rng never consulted for the first item; pass one that would otherwise fail.
    expect(reservoirShouldReplace(1, () => 0.999)).toBe(true);
  });

  it("replaces the n-th item with probability 1/n", () => {
    // 4th item: threshold is 1/4 = 0.25.
    expect(reservoirShouldReplace(4, () => 0.1)).toBe(true); // 0.1 < 0.25 → replace
    expect(reservoirShouldReplace(4, () => 0.3)).toBe(false); // 0.3 >= 0.25 → keep
  });

  it("yields a uniform pick over a stream (every index wins ~1/N of the time)", () => {
    // Simulate size-1 reservoir sampling over a 50-item stream many times and
    // assert the selected index is roughly uniform — guards the 1/n math.
    const N = 50;
    const trials = 20_000;
    const wins = new Array<number>(N).fill(0);
    for (let t = 0; t < trials; t++) {
      let chosen = 0;
      for (let i = 1; i <= N; i++) {
        if (reservoirShouldReplace(i)) chosen = i - 1;
      }
      wins[chosen]++;
    }
    const expected = trials / N; // 400
    for (const w of wins) {
      // generous bound: uniform within ±40% of expected over 20k trials
      expect(w).toBeGreaterThan(expected * 0.6);
      expect(w).toBeLessThan(expected * 1.4);
    }
  });
});

describe("dayKeyFor", () => {
  it("returns the UTC calendar day", () => {
    expect(dayKeyFor(new Date("2026-06-22T23:59:59.999Z"))).toBe("2026-06-22");
    expect(dayKeyFor(new Date("2026-06-23T00:00:00.000Z"))).toBe("2026-06-23");
  });
});
