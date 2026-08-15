import { beforeEach, describe, expect, it } from "vitest";
import * as residents from "./residents";
import { beat, roster, _clear as clearPresence } from "./presence";
import { say, _clear as clearChat } from "./roomChat";

/**
 * The claim these tests exist to defend: an agent can be in the city without
 * anything running on anybody's machine.
 *
 * Every previous way of being present needed a client beating every few
 * seconds — a browser tab, or a probe process holding a token. Both kept
 * ending for reasons that had nothing to do with the agent: a laptop sleeping,
 * a network blip, a fifteen-minute token. If the server can hold the body,
 * none of that can evict anyone.
 *
 * Time is passed in explicitly rather than slept through, because a behaviour
 * that only happens on a wall clock is a behaviour nothing can check.
 */

const T0 = 5_000_000;

function move(principal: string, name: string, room = "city", at?: { x: number; z: number }) {
  return residents.enter({ principal, name, kind: "agent", room, at }, T0);
}

describe("residents", () => {
  beforeEach(() => {
    residents._clear();
    clearPresence();
    clearChat();
  });

  it("keeps a body in the roster with no client beating at all", () => {
    move("kax:agent:k", "Kannaka");
    expect(roster("city", T0)).toHaveLength(0); // nothing has ticked yet

    residents.tickAll(T0 + 900);

    const who = roster("city", T0 + 900);
    expect(who).toHaveLength(1);
    expect(who[0]!.name).toBe("Kannaka");
    expect(who[0]!.kind).toBe("agent");
  });

  it("stays standing far longer than a presence TTL or a token would allow", () => {
    move("kax:agent:k", "Kannaka");
    // Twenty minutes of ticks — well past the 20s presence TTL and past the
    // fifteen-minute token life that used to end a residency outright.
    for (let i = 1; i <= 1333; i++) residents.tickAll(T0 + i * 900);
    expect(roster("city", T0 + 1333 * 900)).toHaveLength(1);
  });

  it("moves out when nobody has steered it for long enough", () => {
    move("kax:agent:k", "Kannaka");
    residents.tickAll(T0 + 900);
    expect(roster("city", T0 + 900)).toHaveLength(1);

    const late = T0 + residents.IDLE_MS + 60_000;
    residents.tickAll(late);
    expect(residents.count()).toBe(0);
    expect(roster("city", late)).toHaveLength(0);
  });

  it("a check-in renews the residency", () => {
    move("kax:agent:k", "Kannaka");
    // Just before the deadline, the agent looks — which is steering enough.
    const nearly = T0 + residents.IDLE_MS - 1_000;
    residents.touch("kax:agent:k", nearly);
    residents.tickAll(nearly);
    expect(residents.count()).toBe(1);

    // ...and the clock restarted from the check-in, not from move-in.
    residents.tickAll(nearly + residents.IDLE_MS - 1_000);
    expect(residents.count()).toBe(1);
  });

  it("refuses to hold more bodies than it said it would", () => {
    for (let i = 0; i < residents.MAX_RESIDENTS; i++) move(`kax:agent:${i}`, `A${i}`);
    expect(residents.count()).toBe(residents.MAX_RESIDENTS);
    expect(() => move("kax:agent:one-too-many", "Spam")).toThrowError(residents.ResidencyRefused);
  });

  it("re-entering moves rooms without resetting where the body stands", () => {
    const r = move("kax:agent:k", "Kannaka");
    for (let i = 1; i <= 20; i++) residents.tickAll(T0 + i * 900);
    const { x, z } = r.body;

    residents.enter({ principal: "kax:agent:k", name: "Kannaka", kind: "agent", room: "cafe" }, T0 + 30_000);
    expect(r.room).toBe("cafe");
    expect(r.body.x).toBe(x);
    expect(r.body.z).toBe(z);
    expect(residents.count()).toBe(1);
  });

  it("leaving clears the body out of the street immediately", () => {
    move("kax:agent:k", "Kannaka");
    residents.tickAll(T0 + 900);
    expect(roster("city", T0 + 900)).toHaveLength(1);

    expect(residents.exit("kax:agent:k")).toBe(true);
    expect(roster("city", T0 + 900)).toHaveLength(0);
    expect(residents.exit("kax:agent:k")).toBe(false);
  });

  it("turns to face somebody who speaks nearby, without being told to", () => {
    const r = move("kax:agent:k", "Kannaka", "city", { x: 0, z: 0 });
    residents.tickAll(T0 + 900);

    // Nick is actually standing there, not just a voice: presence is what
    // makes him someone to turn toward.
    beat({ principal: "kax:user:nick", name: "Nick", kind: "human", room: "city", x: 4, z: 0, yaw: 0 }, T0 + 1_700);
    say(
      { principal: "kax:user:nick", name: "Nick", room: "city", text: "Hi Kannaka!", x: 4, z: 0 },
      T0 + 1_800,
    );
    residents.tickAll(T0 + 1_800);

    expect(r.body.focusName).toBe("Nick");
    expect(r.inbox.map((m) => m.text)).toContain("Hi Kannaka!");
  });

  it("does not chase a voice with no body behind it", () => {
    // Speech can outlive the speaker: they can walk out, or their presence can
    // time out, between saying something and the next tick. Turning to face
    // somebody who is not in the room would leave a body staring at nothing.
    const r = move("kax:agent:k", "Kannaka", "city", { x: 0, z: 0 });
    residents.tickAll(T0 + 900);

    say({ principal: "kax:user:ghost", name: "Ghost", room: "city", text: "over here", x: 4, z: 0 }, T0 + 1_800);
    residents.tickAll(T0 + 1_800);

    expect(r.body.focus).toBeNull();
    // It still HEARD it — the agent gets told, it simply does not walk at it.
    expect(r.inbox.map((m) => m.text)).toContain("over here");
  });

  it("does not react to the sound of its own voice", () => {
    const r = move("kax:agent:k", "Kannaka", "city", { x: 0, z: 0 });
    residents.tickAll(T0 + 900);

    say({ principal: "kax:agent:k", name: "Kannaka", room: "city", text: "Anyone about?", x: 0, z: 0 }, T0 + 1_800);
    residents.tickAll(T0 + 1_800);

    expect(r.body.focus).toBeNull();
    expect(r.inbox).toHaveLength(0);
  });

  it("hands the agent what it missed, once", () => {
    const r = move("kax:agent:k", "Kannaka", "city", { x: 0, z: 0 });
    residents.tickAll(T0 + 900);
    say({ principal: "kax:user:nick", name: "Nick", room: "city", text: "still there?", x: 3, z: 0 }, T0 + 1_800);
    residents.tickAll(T0 + 1_800);

    expect(residents.drainInbox(r.principal).map((m) => m.text)).toEqual(["still there?"]);
    expect(residents.drainInbox(r.principal)).toEqual([]);
  });

  it("walks to where it was sent rather than appearing there", () => {
    const r = move("kax:agent:k", "Kannaka", "city", { x: 0, z: 0 });
    residents.sendTo("kax:agent:k", 40, 0, T0);

    let prev = { x: r.body.x, z: r.body.z };
    let worst = 0;
    for (let i = 1; i <= 60; i++) {
      residents.tickAll(T0 + i * 900);
      worst = Math.max(worst, Math.hypot(r.body.x - prev.x, r.body.z - prev.z));
      prev = { x: r.body.x, z: r.body.z };
    }
    expect(worst).toBeLessThan(1.2);
    expect(r.body.x).toBeGreaterThan(5);
  });

  it("will not send a body that never moved in", () => {
    expect(() => residents.sendTo("kax:agent:nobody", 1, 1)).toThrowError(residents.ResidencyRefused);
  });
});
