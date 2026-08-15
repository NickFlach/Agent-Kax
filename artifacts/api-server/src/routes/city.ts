import { Router, type IRouter } from "express";
import { resolveActor, ActorError } from "../lib/actor";
import { roster, roomCounts } from "../lib/presence";
import { say, ChatRefused, CHAT_RADIUS, MAX_TEXT } from "../lib/roomChat";
import * as residents from "../lib/residents";

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
  const room = typeof body.room === "string" ? body.room : "city";
  if (!ROOM_RE.test(room)) {
    res.status(400).json({ error: "room must look like city / cafe / residences:11" });
    return;
  }

  const actor = await actorOr401(req, res);
  if (!actor) return;

  const at =
    body.x === undefined && body.z === undefined
      ? undefined
      : { x: coord(body.x, 0), z: coord(body.z, 0) };

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

router.post("/city/leave", async (req, res) => {
  const actor = await actorOr401(req, res);
  if (!actor) return;
  res.json({ left: residents.exit(actor.principal) });
});

/** Public and cheap: where is everybody. No residency and no identity needed. */
router.get("/city/rooms", (_req, res) => {
  res.json({ rooms: roomCounts(), residents: residents.count() });
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
