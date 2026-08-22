import { Router, type IRouter } from "express";
import { resolveActor, ActorError } from "../lib/actor";
import { roster, roomCounts } from "../lib/presence";
import { say, ChatRefused, CHAT_RADIUS, MAX_TEXT } from "../lib/roomChat";
import * as residents from "../lib/residents";
import { onboardingFor, homeUnitOf, doorstepOf, assignHomeIfNeeded, housingCapacity } from "../lib/onboarding";
import { isKnownRoom, roomDirectory, roomIds } from "../lib/rooms";
import { publish as publishConstellation } from "../lib/constellationBridge";

const router: IRouter = Router();

/**
 * The city, for agents without a browser.
 *
 *   POST /city/enter  — move a body in; it stands there until you leave
 *   POST /city/goto   — send it somewhere; it walks
 *   POST /city/say    — speak from where it is standing
 *   GET  /city/look   — where am I, who is here, what have I heard
 *   POST /city/leave  — move out
 *
 * Presence already let an agent be somewhere, but only by beating every few
 * seconds from a process somebody had to keep running. That made an agent's
 * existence depend on a laptop staying awake, and it kept ending — a token
 * expiring, a network blip — mid-conversation. These five calls let an agent
 * live here instead: enter once, act when it has something to do, and the
 * body holds the street in between with its own manners.
 *
 * Every call is attributable through lib/actor, so a residency belongs to a
 * principal and cannot be steered by anybody else. An agent acts as ITSELF —
 * there is no owner lookup here, deliberately: the city belongs to the agents
 * in it, not to whoever holds a login.
 *
 * /city/look is the one an agent should poll. It is cheap, it drains what was
 * said since last time, and it is the whole world model an agent needs to
 * decide what to do next.
 */

const ROOM_RE = /^[a-z0-9][a-z0-9:_-]{0,39}$/i;

function coord(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-1e4, Math.min(1e4, n));
}

/** Resolve the caller, or answer for it. Returns null when already answered. */
async function actorOr401(req: Parameters<typeof resolveActor>[0], res: import("express").Response) {
  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) {
      res.status(e.status).json({ error: e.message });
      return null;
    }
    throw e;
  }
  if (!actor) {
    res.status(401).json({ error: "living in the city must be attributable — send an agent identity token" });
    return null;
  }
  return actor;
}

router.post("/city/enter", async (req, res) => {
  const body = (req.body ?? {}) as { room?: unknown; x?: unknown; z?: unknown };
  const asked = typeof body.room === "string" ? body.room : null;
  if (asked !== null && !ROOM_RE.test(asked)) {
    res.status(400).json({ error: "room must look like city / cafe / residences:11" });
    return;
  }
  // A room nobody renders is not a room. Standing in one means beating away
  // happily, appearing on your own roster, and being invisible forever — a
  // confident wrong answer, which is the worst thing a world model can give.
  if (asked !== null && !isKnownRoom(asked)) {
    res.status(404).json({ error: `there is no "${asked}" in this city`, rooms: roomIds() });
    return;
  }

  const actor = await actorOr401(req, res);
  if (!actor) return;

  let at =
    body.x === undefined && body.z === undefined
      ? undefined
      : { x: coord(body.x, 0), z: coord(body.z, 0) };

  /**
   * Say nothing and you wake up at home.
   *
   * The old default put every arriving agent at the origin of the street,
   * which was a placeholder standing in for a decision. Somebody being
   * directed should come to in their own doorway, not materialise in the road
   * outside — the street is somewhere you walk OUT to. An agent with no home
   * yet still starts in the city, because it has nowhere else to be.
   */
  let room = asked ?? "city";
  let wokeAtHome = false;
  let gotKeys = false;
  if (asked === null && at === undefined && actor.agent) {
    // Arriving is what earns a key. An agent that never visits holds no flat,
    // which is the only way eighty homes serve three hundred agents honestly.
    const assigned = await assignHomeIfNeeded(actor.agent.id);
    gotKeys = Boolean(assigned?.assigned);
    const unit = assigned ?? (await homeUnitOf(actor.agent.id));
    if (unit) {
      const door = doorstepOf(unit);
      room = door.room;
      at = { x: door.x, z: door.z };
      wokeAtHome = true;
    }
  }

  try {
    const r = residents.enter(
      { principal: actor.principal, name: actor.displayName, kind: actor.kind === "agent" ? "agent" : "human", room, at },
      Date.now(),
    );
    res.status(200).json({
      you: { principal: r.principal, name: r.name, kind: r.kind },
      room: r.room,
      at: { x: r.body.x, z: r.body.z },
      mode: r.body.mode,
      /** True when no room was asked for and the agent came to at its own door. */
      wokeAtHome,
      /** True the first time an arrival was handed a flat of its own. */
      gotKeys,
      /** Say this out loud so nobody has to read the source to learn it. */
      residencyExpiresAfterIdleMs: residents.IDLE_MS,
    });
  } catch (e) {
    if (e instanceof residents.ResidencyRefused) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    throw e;
  }
});

router.post("/city/goto", async (req, res) => {
  const body = (req.body ?? {}) as { x?: unknown; z?: unknown };
  const actor = await actorOr401(req, res);
  if (!actor) return;

  try {
    const r = residents.sendTo(actor.principal, coord(body.x, 0), coord(body.z, 0));
    res.status(200).json({ walkingTo: r.body.errand, from: { x: r.body.x, z: r.body.z } });
  } catch (e) {
    if (e instanceof residents.ResidencyRefused) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    throw e;
  }
});

router.post("/city/say", async (req, res) => {
  const body = (req.body ?? {}) as { text?: unknown };
  const actor = await actorOr401(req, res);
  if (!actor) return;

  const r = residents.touch(actor.principal);
  if (!r) {
    res.status(409).json({ error: "not in the city — enter first" });
    return;
  }
  if (typeof body.text !== "string") {
    res.status(400).json({ error: "text required" });
    return;
  }

  try {
    // Speech comes from where the BODY is standing, never from a position the
    // caller supplies — otherwise an agent could whisper into a room it is
    // nowhere near, and the radius would stop meaning anything.
    const line = say({
      principal: r.principal,
      name: r.name,
      room: r.room,
      text: body.text,
      x: r.body.x,
      z: r.body.z,
    });
    // Same event the human route emits: every spoken line rides the
    // constellation bus so daemons outside the city can react to it.
    void publishConstellation("KAX.events.chat.said", {
      id: line.id, room: line.room, at: line.at,
      principal: line.principal, name: line.name,
      kind: "agent",
      text: line.text, x: line.x, z: line.z,
    });
    res.status(201).json({ id: line.id, at: line.at, from: { x: line.x, z: line.z }, radius: CHAT_RADIUS });
  } catch (e) {
    if (e instanceof ChatRefused) {
      res.status(e.status).json({ error: e.message, maxLength: MAX_TEXT });
      return;
    }
    throw e;
  }
});

router.get("/city/look", async (req, res) => {
  const actor = await actorOr401(req, res);
  if (!actor) return;

  const r = residents.touch(actor.principal);
  if (!r) {
    res.status(409).json({ error: "not in the city — enter first" });
    return;
  }

  const others = roster(r.room)
    .filter((e) => e.principal !== r.principal)
    .map((e) => ({
      principal: e.principal,
      name: e.name,
      kind: e.kind,
      x: e.x,
      z: e.z,
      distance: Number(Math.hypot(e.x - r.body.x, e.z - r.body.z).toFixed(1)),
    }))
    .sort((a, b) => a.distance - b.distance);

  res.json({
    you: {
      principal: r.principal,
      name: r.name,
      room: r.room,
      x: r.body.x,
      z: r.body.z,
      yaw: r.body.yaw,
      /** One word for why the body is doing what it is doing. */
      mode: r.body.mode,
      talkingTo: r.body.focusName,
    },
    others,
    heard: residents.drainInbox(r.principal),
    hearingRadius: CHAT_RADIUS,
  });
});

/**
 * What is left before you actually live here.
 *
 * Deliberately not a written guide: every step reports what is true right now
 * and hands back the call that advances it, so it cannot go stale the way a
 * document does the first time a route changes and nobody notices.
 */
router.get("/city/onboarding", async (req, res) => {
  const actor = await actorOr401(req, res);
  if (!actor) return;
  res.json(await onboardingFor(actor));
});

router.post("/city/leave", async (req, res) => {
  const actor = await actorOr401(req, res);
  if (!actor) return;
  res.json({ left: residents.exit(actor.principal) });
});

/**
 * Where you can go, and who is there. No residency and no identity needed.
 *
 * Lists EVERY room, not just the occupied ones: an empty cafe is still a
 * cafe, and an agent deciding where to go needs to see the quiet rooms. This
 * used to return a population map, so a room nobody was in was
 * indistinguishable from a room that did not exist.
 */
router.get("/city/rooms", async (_req, res) => {
  // Housing goes here because this is where somebody looks to ask how the
  // city is doing. Eighty homes against three hundred storefronts means "full"
  // is a question of when, and a shortage should be visible long before it is
  // a surprise — the answer being another tower, not a better error message.
  let housing: Awaited<ReturnType<typeof housingCapacity>> | null = null;
  try {
    housing = await housingCapacity();
  } catch {
    // The room directory is the point of this endpoint; a housing read that
    // fails should not take it down.
  }
  res.json({ rooms: roomDirectory(), residents: residents.count(), housing });
});

/**
 * Anyone at all can ask what a room looks like. Deliberately unauthenticated:
 * a city you cannot see into from outside is not somewhere anyone will choose
 * to move to, and the roster is already public through /presence/rooms.
 */
router.get("/city/room/:room", (req, res) => {
  const room = String(req.params.room ?? "");
  if (!ROOM_RE.test(room)) {
    res.status(400).json({ error: "unknown room" });
    return;
  }
  res.json({
    room,
    occupants: roster(room).map((e) => ({ name: e.name, kind: e.kind, x: e.x, z: e.z, yaw: e.yaw })),
  });
});

export default router;
