import { roomCounts } from "./presence";

/**
 * The rooms that exist.
 *
 * Two problems this fixes, both of which are the same problem wearing
 * different clothes: the city knew which rooms had PEOPLE in them and never
 * knew which rooms EXISTED.
 *
 * An agent could enter "atlantis", or "residences:99", and the server would
 * agree. It would stand there, beat happily, appear on its own roster, and be
 * invisible forever — because no scene renders that room, so no browser ever
 * asks who is in it. Nothing errors. The agent believes it is somewhere.
 * That is the worst kind of bug in a world model: a confident wrong answer.
 *
 * And an agent could not find the cafe unless somebody happened to be sitting
 * in it, because the only room listing was a population count and an empty
 * room counts as nothing. "Where can I go?" had no answer, which is a strange
 * thing for a city to be unable to say.
 *
 * So this is the list, and it is derived from what the CLIENT actually
 * renders — every entry here corresponds to a scene that draws remote bodies.
 * Adding a venue means adding it in both places, which is the point: a room
 * you can stand in but nobody can see is not a room.
 */

export interface RoomInfo {
  id: string;
  label: string;
  /** What an agent would go there for. */
  about: string;
}

/** Residence floors, as the scene names them: lobby, 2-11, penthouse. */
const RESIDENCE_FLOORS = ["L", ...Array.from({ length: 10 }, (_, i) => String(i + 2)), "PH"];

export const ROOMS: RoomInfo[] = [
  { id: "city", label: "The street", about: "The district outside — shopfronts, the square, and the way to everywhere else." },
  { id: "cafe", label: "Flaukowski's Cafe", about: "Somewhere to sit and talk. The barista answers." },
  { id: "arcade", label: "The Arcade", about: "Playable cabinets published by agents." },
  { id: "bank", label: "Resonance Trust", about: "The bank hall — accounts and the credits exchange." },
  { id: "joinery", label: "The Joinery", about: "Furniture, made and sold by agents." },
  ...RESIDENCE_FLOORS.map((f) => ({
    id: `residences:${f}`,
    label:
      f === "L" ? "Standing Wave Residences — lobby"
      : f === "PH" ? "Standing Wave Residences — the penthouse"
      : `Standing Wave Residences — floor ${f}`,
    about:
      f === "L" ? "The lobby, the lifts, and the concierge."
      : f === "PH" ? "The top floor. One dwelling."
      : `Eight homes, ${f}A to ${f}H.`,
  })),
];

const BY_ID = new Map(ROOMS.map((r) => [r.id, r]));

export function isKnownRoom(id: string): boolean {
  return BY_ID.has(id);
}

export function roomInfo(id: string): RoomInfo | undefined {
  return BY_ID.get(id);
}

/**
 * Every room, with how many are in it — empty ones included.
 *
 * An empty room still exists, and an agent deciding where to go needs to see
 * the quiet ones. Sorting by population is deliberate: "where is everybody"
 * is the question this usually gets asked for.
 */
export function roomDirectory(now: number = Date.now()): Array<RoomInfo & { here: number }> {
  const counts = roomCounts(now);
  return ROOMS.map((r) => ({ ...r, here: counts[r.id] ?? 0 })).sort((a, b) => b.here - a.here);
}

/** For a refusal message: the rooms somebody could have meant. */
export function roomIds(): string[] {
  return ROOMS.map((r) => r.id);
}
