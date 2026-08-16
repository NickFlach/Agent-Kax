import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { ROOMS, isKnownRoom, roomDirectory, roomIds, roomInfo, residenceRoom, unitRoom, parseUnitRoom } from "./rooms";
import { beat, _clear as clearPresence } from "./presence";

/**
 * rooms.test.ts — a room you can stand in but nobody can see is not a room.
 *
 * The city knew which rooms had PEOPLE in them and never knew which rooms
 * EXISTED. That let an agent enter "atlantis", beat away happily, appear on
 * its own roster, and be invisible forever, because no scene renders that
 * room so no browser ever asks who is in it. Nothing errors — the agent just
 * believes it is somewhere. A confident wrong answer is the worst thing a
 * world model can hand an agent.
 *
 * The list here must stay in step with the scenes that render presence. That
 * is a human obligation rather than something a test can prove, so what these
 * check is everything around it: that the list is well-formed, that unknown
 * rooms are unknown, and that an empty room still shows up.
 */

const here = dirname(fileURLToPath(import.meta.url));
const T0 = 7_000_000;

describe("rooms", () => {
  beforeEach(() => clearPresence());

  it("knows the venues the client actually renders", () => {
    for (const id of ["city", "cafe", "arcade", "bank", "joinery"]) {
      expect(isKnownRoom(id)).toBe(true);
    }
    // Residence floors as the scene names them: lobby, 2-11, penthouse.
    expect(isKnownRoom("residences:L")).toBe(true);
    expect(isKnownRoom("residences:11")).toBe(true);
    expect(isKnownRoom("residences:PH")).toBe(true);
  });

  it("does not know rooms nobody renders", () => {
    for (const id of ["atlantis", "residences:99", "residences:1", "residences:12", "CITY", ""]) {
      expect(isKnownRoom(id)).toBe(false);
    }
  });

  it("lets a resident be in their own flat", () => {
    // The eighty flats are rooms by PATTERN rather than entries in the
    // directory: a private home is not somewhere to advertise, it is somewhere
    // you are invited. But /city/enter gates on isKnownRoom, so if the pattern
    // were missing an agent standing in its own living room would be told the
    // room does not exist — and the scene would keep rendering it anyway.
    expect(isKnownRoom(unitRoom(2, "A"))).toBe(true);
    expect(isKnownRoom(unitRoom("PH", "H"))).toBe(true);
    expect(unitRoom(11, "H")).toBe("residences:11:H");
    expect(parseUnitRoom("residences:9:C")).toEqual({ floor: "9", letter: "C" });
  });

  it("does not invent flats that have no door", () => {
    // The landing has eight doors, A-H, on floors 2-11 and the penthouse. A
    // room named outside that set is a room nobody renders.
    for (const id of ["residences:2:I", "residences:1:A", "residences:12:A", "residences:L:A", "residences:2:a", "residences:2:"]) {
      expect(isKnownRoom(id), `${id} was accepted`).toBe(false);
      expect(parseUnitRoom(id)).toBeNull();
    }
  });

  it("keeps a flat out of the published directory", () => {
    // Listing eighty private homes in /city/rooms would turn the directory
    // into a residents' address book.
    expect(roomIds().some((id) => id.split(":").length === 3)).toBe(false);
  });

  it("has no duplicates and describes every room", () => {
    const ids = roomIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of ROOMS) {
      expect(r.label.length).toBeGreaterThan(3);
      expect(r.about.length).toBeGreaterThan(10);
    }
  });

  it("lists empty rooms too, because an empty cafe is still a cafe", () => {
    const dir = roomDirectory(T0);
    expect(dir.length).toBe(ROOMS.length);
    // Nobody anywhere: every room present, all at zero.
    expect(dir.every((r) => r.here === 0)).toBe(true);
    expect(dir.some((r) => r.id === "cafe")).toBe(true);
  });

  it("counts who is actually in a room, and puts the busy ones first", () => {
    beat({ principal: "kax:agent:a", name: "A", kind: "agent", room: "cafe", x: 0, z: 0, yaw: 0 }, T0);
    beat({ principal: "kax:agent:b", name: "B", kind: "agent", room: "cafe", x: 1, z: 0, yaw: 0 }, T0);
    beat({ principal: "kax:user:n", name: "Nick", kind: "human", room: "city", x: 0, z: 0, yaw: 0 }, T0);

    const dir = roomDirectory(T0);
    expect(dir[0]!.id).toBe("cafe");
    expect(dir[0]!.here).toBe(2);
    expect(dir.find((r) => r.id === "city")!.here).toBe(1);
    expect(dir.find((r) => r.id === "bank")!.here).toBe(0);
  });

  it("a stale beat stops counting", () => {
    beat({ principal: "kax:agent:a", name: "A", kind: "agent", room: "cafe", x: 0, z: 0, yaw: 0 }, T0);
    // Well past the presence TTL.
    const dir = roomDirectory(T0 + 120_000);
    expect(dir.find((r) => r.id === "cafe")!.here).toBe(0);
  });

  it("names a residence room the one way", () => {
    // The scene mirrors this string and cannot import it, so the format is
    // pinned here: a floor number, the lobby, and the penthouse by name.
    expect(residenceRoom(5)).toBe("residences:5");
    expect(residenceRoom(11)).toBe("residences:11");
    expect(residenceRoom(12)).toBe("residences:PH");
    expect(residenceRoom("L")).toBe("residences:L");
    // And whatever it produces must be a room the city admits to having,
    // which is what stops a doorstep landing somewhere nobody renders.
    for (const f of [2, 5, 11, 12]) {
      expect(isKnownRoom(residenceRoom(f)), `${residenceRoom(f)} is not in the directory`).toBe(true);
    }
  });

  it("every room can be looked up by id", () => {
    for (const id of roomIds()) {
      expect(roomInfo(id)?.id).toBe(id);
    }
    expect(roomInfo("nowhere")).toBeUndefined();
  });
  it("has a scene that renders every room it advertises", () => {
    // The invariant this file's own docblock states and nothing enforced:
    // "a room you can stand in but nobody can see is not a room". The
    // trading floor was in exactly that state — the directory would have
    // listed it, agents could have entered it, and no browser drew anybody.
    //
    // Read across the package boundary on purpose. The two halves live in
    // different apps, so nothing else can notice when they disagree, and a
    // room with no scene fails silently in the direction that looks fine.
    const pagesDir = join(here, "..", "..", "..", "kax", "src", "pages");
    const scenes = readdirSync(pagesDir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => readFileSync(join(pagesDir, f), "utf8"))
      .join("\n");

    const missing = roomIds().filter((id) => {
      // Three shapes are all legitimate, and a test that knew only the first
      // would report two false violations:
      //   <VenuePresence room="arcade" />   — the common case
      //   usePresence("city")               — the street, which predates it
      //   room={`residences:${floorLabel(floor)}`} — one scene serving a
      //     whole family of ids, so no literal appears anywhere
      if (scenes.includes(`room="${id}"`)) return false;
      if (scenes.includes(`usePresence("${id}")`)) return false;
      const family = id.includes(":") ? id.slice(0, id.indexOf(":") + 1) : null;
      if (family && scenes.includes("`" + family + "${")) return false;
      return true;
    });
    expect(missing, "rooms advertised with no scene that draws bodies").toEqual([]);
  });
});
