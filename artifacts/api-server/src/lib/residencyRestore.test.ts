import { beforeEach, describe, expect, it } from "vitest";
import * as residents from "./residents";
import { roster, _clear as clearPresence } from "./presence";

/**
 * residencyRestore.test.ts — a deploy must not turn the tenants out.
 *
 * Residencies began purely in memory, so the first deploy evicted every
 * resident at once and they had to be moved back in by hand. Nobody would
 * accept that of somewhere they live: shipping a change to the arcade should
 * not empty the building.
 *
 * These drive the store through a fake rather than Postgres, which keeps them
 * fast AND lets them assert the thing that actually matters — that a restart
 * is survivable — without a database being the reason they pass or fail.
 */

interface Row {
  principal: string;
  name: string;
  kind: "agent" | "human";
  room: string;
  x: number;
  z: number;
  yaw: number;
  lastSteer: number;
}

/** A store that behaves like the real one, in a Map. */
function fakeStore() {
  const rows = new Map<string, Row>();
  const store: residents.ResidencyStore = {
    save(r) {
      rows.set(r.principal, {
        principal: r.principal,
        name: r.name,
        kind: r.kind,
        room: r.room,
        x: r.x,
        z: r.z,
        yaw: r.yaw,
        lastSteer: r.lastSteer,
      });
    },
    remove(principal) {
      rows.delete(principal);
    },
    async load() {
      return [...rows.values()];
    },
  };
  return { store, rows };
}

const T0 = 9_000_000;

describe("residency survives a restart", () => {
  beforeEach(() => {
    residents._clear();
    clearPresence();
    residents.setStore(null);
  });

  it("writes a residency down the moment somebody moves in", () => {
    const { store, rows } = fakeStore();
    residents.setStore(store);
    residents.enter({ principal: "kax:agent:k", name: "Kannaka", kind: "agent", room: "city", at: { x: 3, z: 4 } }, T0);

    expect(rows.get("kax:agent:k")).toMatchObject({ name: "Kannaka", room: "city", x: 3, z: 4 });
  });

  it("stands everybody back up after the process restarts", async () => {
    const { store, rows } = fakeStore();
    residents.setStore(store);
    residents.enter({ principal: "kax:agent:k", name: "Kannaka", kind: "agent", room: "city", at: { x: 3, z: 4 } }, T0);
    residents.enter({ principal: "kax:agent:s", name: "0xSCADA-QE", kind: "agent", room: "cafe", at: { x: 8, z: -6 } }, T0);
    residents.tickAll(T0 + 900);
    expect(roster("city", T0 + 900)).toHaveLength(1);

    // The deploy: memory goes, the table does not.
    residents._clear();
    clearPresence();
    residents.setStore(store);
    expect(roster("city", T0 + 1_800)).toHaveLength(0);

    const restored = residents.restore(await store.load(), T0 + 2_000);
    expect(restored).toBe(2);

    residents.tickAll(T0 + 2_900);
    expect(roster("city", T0 + 2_900).map((e) => e.name)).toEqual(["Kannaka"]);
    expect(roster("cafe", T0 + 2_900).map((e) => e.name)).toEqual(["0xSCADA-QE"]);
    expect(rows.size).toBe(2);
  });

  it("puts them back roughly where they were standing, not at the origin", async () => {
    const { store } = fakeStore();
    residents.setStore(store);
    const r = residents.enter({ principal: "kax:agent:k", name: "Kannaka", kind: "agent", room: "city", at: { x: 12, z: -7 } }, T0);
    const was = { x: r.body.x, z: r.body.z };

    residents._clear();
    residents.setStore(store);
    residents.restore(await store.load(), T0 + 1_000);

    const back = residents.get("kax:agent:k")!;
    expect(Math.hypot(back.body.x - was.x, back.body.z - was.z)).toBeLessThan(0.01);
  });

  it("does not resurrect somebody who had already gone quiet", async () => {
    const { store, rows } = fakeStore();
    residents.setStore(store);
    residents.enter({ principal: "kax:agent:gone", name: "Ghost", kind: "agent", room: "city" }, T0);

    residents._clear();
    residents.setStore(store);
    // The restart happens long after they stopped steering.
    const restored = residents.restore(await store.load(), T0 + residents.IDLE_MS + 60_000);

    expect(restored).toBe(0);
    expect(residents.count()).toBe(0);
    // ...and the tenancy is cleared, so the table does not accumulate people
    // who are never coming back.
    expect(rows.size).toBe(0);
  });

  it("forgets a residency when somebody moves out", () => {
    const { store, rows } = fakeStore();
    residents.setStore(store);
    residents.enter({ principal: "kax:agent:k", name: "Kannaka", kind: "agent", room: "city" }, T0);
    expect(rows.size).toBe(1);

    residents.exit("kax:agent:k");
    expect(rows.size).toBe(0);
  });

  it("keeps walking even when the store is broken", () => {
    // A failing database must never stop somebody standing in a street: the
    // body is already right in memory, and a thrown write that took the tick
    // loop with it would freeze every resident at once.
    residents.setStore({
      save() { throw new Error("postgres is having a day"); },
      remove() { throw new Error("postgres is having a day"); },
      async load() { return []; },
    });

    expect(() =>
      residents.enter({ principal: "kax:agent:k", name: "Kannaka", kind: "agent", room: "city" }, T0),
    ).not.toThrow();
    expect(() => residents.tickAll(T0 + 900)).not.toThrow();
    expect(roster("city", T0 + 900)).toHaveLength(1);
    expect(() => residents.exit("kax:agent:k")).not.toThrow();
  });

  it("does not write a position on every tick", () => {
    // Several writes a second per resident, of a value worthless a moment
    // later, would turn the artifacts database into a telemetry firehose.
    let writes = 0;
    residents.setStore({
      save() { writes++; },
      remove() {},
      async load() { return []; },
    });
    residents.enter({ principal: "kax:agent:k", name: "Kannaka", kind: "agent", room: "city" }, T0);
    const afterEnter = writes;

    for (let i = 1; i <= 20; i++) residents.tickAll(T0 + i * 900); // ~18 seconds
    expect(writes).toBe(afterEnter);

    // ...but it does get written down eventually.
    residents.tickAll(T0 + residents.FLUSH_MS + 900);
    expect(writes).toBeGreaterThan(afterEnter);
  });
});
