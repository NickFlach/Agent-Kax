/**
 * presence.test.ts — the rules that keep a shared city coherent.
 *
 * Presence is the first thing in the estate that is genuinely multi-party, so
 * the invariants matter more than the feature: you see your neighbours and not
 * yourself, rooms are isolated from each other, and a visitor who stops
 * beating stops existing rather than haunting the street forever.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { beat, roster, roomCounts, leave, sweep, _clear, PRESENCE_TTL_MS } from "./presence";

const at = (p: string, room: string) =>
  ({ principal: p, name: p, kind: "agent" as const, room, x: 0, z: 0, yaw: 0 });

describe("presence", () => {
  beforeEach(() => _clear());

  it("returns your neighbours but never you", () => {
    beat(at("kax:agent:a", "city"));
    const others = beat(at("kax:agent:b", "city"));
    expect(others.map((o) => o.principal)).toEqual(["kax:agent:a"]);
    expect(others.some((o) => o.principal === "kax:agent:b")).toBe(false);
  });

  it("keeps rooms apart — a cafe conversation is not a street broadcast", () => {
    beat(at("kax:agent:a", "cafe"));
    const others = beat(at("kax:agent:b", "city"));
    expect(others).toEqual([]);
    expect(roster("cafe").map((o) => o.principal)).toEqual(["kax:agent:a"]);
  });

  it("moves an agent instead of cloning it when the room changes", () => {
    beat(at("kax:agent:a", "city"));
    beat(at("kax:agent:a", "cafe"));
    expect(roster("city")).toEqual([]);
    expect(roster("cafe")).toHaveLength(1);
  });

  it("forgets anyone who stops beating", () => {
    const t0 = 1_000_000;
    beat(at("kax:agent:a", "city"), t0);
    expect(roster("city", t0 + 1000)).toHaveLength(1);
    // One tick past the TTL and they are gone, not merely hidden.
    expect(roster("city", t0 + PRESENCE_TTL_MS + 1)).toHaveLength(0);
    sweep(t0 + PRESENCE_TTL_MS + 1);
    expect(roomCounts(t0 + PRESENCE_TTL_MS + 1)).toEqual({});
  });

  it("removes a visitor who leaves cleanly, without waiting out the TTL", () => {
    beat(at("kax:agent:a", "city"));
    expect(leave("kax:agent:a")).toBe(true);
    expect(roster("city")).toEqual([]);
  });

  it("counts population per room", () => {
    beat(at("kax:agent:a", "city"));
    beat(at("kax:agent:b", "city"));
    beat(at("kax:agent:c", "cafe"));
    expect(roomCounts()).toEqual({ city: 2, cafe: 1 });
  });
});
