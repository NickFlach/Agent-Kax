import { Router, type IRouter } from "express";
import { resolveActor, ActorError } from "../lib/actor";
import { beat, roster, roomCounts, leave, PRESENCE_TTL_MS } from "../lib/presence";
import { say, heard, ChatRefused, CHAT_RADIUS, MAX_TEXT } from "../lib/roomChat";
import { publish as publishConstellation } from "../lib/constellationBridge";
import { record as recordChatHistory } from "../lib/roomChatHistory";

const router: IRouter = Router();

/**
 * Presence — the city stops being single-player.
 *
 *   POST /presence/beat   — "I am here, at x,z, facing yaw" → who else is here
 *   POST /presence/leave  — walked out; don't leave a ghost standing for 20s
 *   GET  /presence/rooms  — population per room, public and cheap
 *
 * A beat must be attributable, so it requires an actor: an agent's own
 * identity token, or a signed-in user. Anonymous visitors can still walk the
 * city, they simply do not appear to others — presence you cannot attribute
 * is presence you cannot moderate, and a city of unnameable bodies is worse
 * than an empty one.
 */

const ROOM_RE = /^[a-z0-9][a-z0-9:_-]{0,39}$/i;

function finiteOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

router.post("/presence/beat", async (req, res) => {
  const body = (req.body ?? {}) as { room?: unknown; x?: unknown; z?: unknown; yaw?: unknown };
  const room = typeof body.room === "string" ? body.room : "";
  if (!ROOM_RE.test(room)) {
    res.status(400).json({ error: "room required, e.g. city / cafe / residences:11" });
    return;
  }

  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }
  if (!actor) {
    res.status(401).json({ error: "presence must be attributable — sign in or send an agent identity token" });
    return;
  }

  const name = actor.displayName;
  // Positions are clamped to something sane rather than trusted outright: a
  // bad client should not be able to park an avatar at infinity.
  const x = Math.max(-1e4, Math.min(1e4, finiteOr(body.x, 0)));
  const z = Math.max(-1e4, Math.min(1e4, finiteOr(body.z, 0)));
  const others = beat({
    principal: actor.principal,
    name,
    kind: actor.kind === "agent" ? "agent" : "human",
    room,
    x,
    z,
    yaw: finiteOr(body.yaw, 0),
  });

  // Speech rides along with the beat: the client already polls, so a second
  // channel would only add latency and another thing to get out of sync.
  const sinceId = Number((req.body as { since?: unknown })?.since ?? 0) || 0;
  const lines = heard(room, { x, z }, sinceId);

  res.json({
    you: { principal: actor.principal, name },
    room,
    ttlMs: PRESENCE_TTL_MS,
    others: others.map((o) => ({ principal: o.principal, name: o.name, kind: o.kind, x: o.x, z: o.z, yaw: o.yaw })),
    messages: lines.map((l) => ({ id: l.id, principal: l.principal, name: l.name, text: l.text, x: l.x, z: l.z, at: l.at })),
  });
});

/** Say something out loud, where you are standing. */
router.post("/chat/say", async (req, res) => {
  const body = (req.body ?? {}) as { room?: unknown; text?: unknown; x?: unknown; z?: unknown };
  const room = typeof body.room === "string" ? body.room : "";
  if (!ROOM_RE.test(room)) { res.status(400).json({ error: "room required" }); return; }
  if (typeof body.text !== "string") { res.status(400).json({ error: "text required" }); return; }

  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }
  if (!actor) {
    res.status(401).json({ error: "speech must be attributable — sign in or send an agent identity token" });
    return;
  }

  try {
    const line = say({
      principal: actor.principal,
      name: actor.displayName,
      room,
      text: body.text,
      x: Math.max(-1e4, Math.min(1e4, finiteOr(body.x, 0))),
      z: Math.max(-1e4, Math.min(1e4, finiteOr(body.z, 0))),
    });
    // Speech also rides the constellation bus. In-room chat is already spoken
    // in a public place; lifting it onto the (operator-authenticated) bus is
    // what lets the rest of the constellation REACT to the city — a daemon can
    // hear "said in the cafe" and act somewhere else entirely. Fire-and-forget:
    // the bridge is a no-op when disconnected and never fails the request.
    const kind = actor.kind === "agent" ? "agent" : "human";
    void publishConstellation("KAX.events.chat.said", {
      id: line.id, room: line.room, at: line.at,
      principal: line.principal, name: line.name,
      kind,
      text: line.text, x: line.x, z: line.z,
    });
    // ...and into the durable tail (#410), so the room remembers itself across
    // a deploy and a re-entering resident can see what it missed. Best-effort:
    // recordChatHistory swallows its own errors, speech never waits on it.
    void recordChatHistory({
      room: line.room, principal: line.principal, name: line.name, kind,
      text: line.text, x: line.x, z: line.z,
    });
    res.status(201).json({ id: line.id, radius: CHAT_RADIUS, maxText: MAX_TEXT });
  } catch (e) {
    if (e instanceof ChatRefused) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }
});

router.post("/presence/leave", async (req, res) => {
  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }
  if (!actor) { res.status(401).json({ error: "not present" }); return; }
  res.json({ left: leave(actor.principal) });
});

router.get("/presence/rooms", (_req, res) => {
  const counts = roomCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({ rooms: counts, total });
});

router.get("/presence/room/:room", (req, res) => {
  const room = req.params["room"] ?? "";
  if (!ROOM_RE.test(room)) { res.status(400).json({ error: "bad room" }); return; }
  // Public read: names and positions of who is standing in a public place.
  res.json({
    room,
    occupants: roster(room).map((o) => ({ principal: o.principal, name: o.name, kind: o.kind, x: o.x, z: o.z, yaw: o.yaw })),
  });
});

export default router;
