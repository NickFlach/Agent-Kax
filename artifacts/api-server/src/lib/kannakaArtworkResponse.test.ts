import { describe, expect, it } from "vitest";
import { artworkPassesFilters } from "./kannakaArtworkResponse";
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
