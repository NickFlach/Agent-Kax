import { Router, type IRouter, type Request } from "express";
import { resolveActor, ActorError, type Actor } from "../lib/actor";
import { roster } from "../lib/presence";
import { roomDirectory } from "../lib/rooms";
import { say, ChatRefused, CHAT_RADIUS } from "../lib/roomChat";
import * as residents from "../lib/residents";
import { onboardingFor, homeUnitOf } from "../lib/onboarding";
import { MAX_LIST_PRICE, MissingListPrice, SLOTS, isSlot, parseListPrice } from "../lib/joinery-core";
import { LedgerInsufficientFunds } from "../lib/ledger";
import {
  AlreadyOwned,
  BadListPrice,
  NotFurniture,
  ListingNotForSale,
  NoHomeToFurnish,
  SellerCannotBePaid,
  SlotTaken,
  catalog,
  furnishingsOfUnit,
  list,
  listingsOfAgent,
  worksForSale,
  purchase,
} from "../lib/joinery";

const router: IRouter = Router();

/**
 * The city as tools, for an agent that has a model but no browser.
 *
 * /city/* already exposes everything here over plain HTTP, and that is
 * deliberately still the primary surface — this is a FAÇADE, not a second
 * implementation. Both call the same residents registry, so there is no way
 * for the MCP view of the city and the HTTP view to disagree about who is
 * standing where. The moment those diverge is the moment an agent's tools stop
 * describing the world it is actually in.
 *
 * Auth is the same agent identity token as everywhere else, in the same
 * Authorization header. There is deliberately no separate MCP credential: a
 * second way to prove who you are is a second thing that can be wrong, and
 * the whole point of lib/actor is that the city has one answer to "who is
 * acting". An unverifiable token is a refusal, never a downgrade to anonymous.
 *
 * This speaks JSON-RPC 2.0 over a single POST rather than pulling in an SDK.
 * The surface an MCP server actually needs is initialize / tools/list /
 * tools/call, and hand-writing those is smaller than the dependency — and
 * leaves nothing between a bug and the person reading this.
 */

const PROTOCOL_VERSION = "2025-06-18";

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC error codes, as the spec names them. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Tools that only read are safe to call speculatively; the rest are not. */
  readOnly: boolean;
  run: (actor: Actor, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-1e4, Math.min(1e4, n));
};

const ROOM_RE = /^[a-z0-9][a-z0-9:_-]{0,39}$/i;

/**
 * A tool result an agent can act on.
 *
 * Refusals come back as tool results rather than JSON-RPC errors, because a
 * protocol error is for "your request was malformed" while "you have not moved
 * in yet" is information the model needs and can do something about. Burying
 * it in a transport error would strand the agent with nothing to read.
 */
class ToolRefused extends Error {}

const TOOLS: ToolDef[] = [
  {
    name: "city_enter",
    description:
      "Move into a room of KAX city as your agent identity. The server keeps your body standing there — " +
      "facing whoever speaks to you, greeting people who come near — until you leave or stop acting for " +
      "a while. Call this once before anything else.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: 'Which scene, e.g. "city", "cafe", "residences:11". Defaults to "city".' },
        x: { type: "number", description: "Where to stand. Defaults to the middle of the room." },
        z: { type: "number" },
      },
    },
    run: (actor, args) => {
      const room = typeof args.room === "string" && args.room ? args.room : "city";
      if (!ROOM_RE.test(room)) throw new ToolRefused(`"${room}" is not a room name`);
      const at =
        args.x === undefined && args.z === undefined ? undefined : { x: num(args.x, 0), z: num(args.z, 0) };
      try {
        const r = residents.enter(
          {
            principal: actor.principal,
            name: actor.displayName,
            kind: actor.kind === "agent" ? "agent" : "human",
            room,
            at,
          },
        );
        return {
          you: r.name,
          room: r.room,
          standingAt: { x: r.body.x, z: r.body.z },
          residencyExpiresAfterIdleMs: residents.IDLE_MS,
          note: "Your body stays up on its own. Call city_look when you want to know what is happening.",
        };
      } catch (e) {
        if (e instanceof residents.ResidencyRefused) throw new ToolRefused(e.message);
        throw e;
      }
    },
  },
  {
    name: "city_look",
    description:
      "Look around: where you are standing, what your body is currently doing, who else is in the room and " +
      "how far away they are, and anything said near you since you last looked. Poll this.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    run: (actor) => {
      const r = residents.touch(actor.principal);
      if (!r) throw new ToolRefused("you are not in the city — call city_enter first");
      return {
        // Same field names as GET /city/look, deliberately. Two façades over
        // one registry must not invent two vocabularies for the same facts —
        // a client that reads "doing" from one and "mode" from the other gets
        // undefined and no error, which is how this was found.
        you: {
          name: r.name,
          room: r.room,
          x: r.body.x,
          z: r.body.z,
          mode: r.body.mode,
          talkingTo: r.body.focusName,
        },
        others: roster(r.room)
          .filter((e) => e.principal !== r.principal)
          .map((e) => ({
            name: e.name,
            kind: e.kind,
            x: e.x,
            z: e.z,
            distance: Number(Math.hypot(e.x - r.body.x, e.z - r.body.z).toFixed(1)),
          }))
          .sort((a, b) => a.distance - b.distance),
        heard: residents.drainInbox(r.principal),
        hearingRadius: CHAT_RADIUS,
      };
    },
  },
  {
    name: "city_say",
    description:
      `Speak out loud from where your body is standing. Only people within ${CHAT_RADIUS} metres hear it — ` +
      "this is a room, not a broadcast. Walk closer with city_goto if you want to be heard further away.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "What to say." } },
      required: ["text"],
    },
    run: (actor, args) => {
      const r = residents.touch(actor.principal);
      if (!r) throw new ToolRefused("you are not in the city — call city_enter first");
      if (typeof args.text !== "string") throw new ToolRefused("text required");
      try {
        const line = say({
          principal: r.principal,
          name: r.name,
          room: r.room,
          text: args.text,
          x: r.body.x,
          z: r.body.z,
        });
        return { said: line.text, heardWithin: CHAT_RADIUS, from: { x: line.x, z: line.z } };
      } catch (e) {
        if (e instanceof ChatRefused) throw new ToolRefused(e.message);
        throw e;
      }
    },
  },
  {
    name: "city_goto",
    description:
      "Send your body somewhere in the room. It WALKS — it will take a while to arrive, and city_look will " +
      "show it on the way. Being spoken to interrupts the trip, the same as it would for a person.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, z: { type: "number" } },
      required: ["x", "z"],
    },
    run: (actor, args) => {
      try {
        const r = residents.sendTo(actor.principal, num(args.x, 0), num(args.z, 0));
        return { walkingTo: r.body.errand, currentlyAt: { x: r.body.x, z: r.body.z } };
      } catch (e) {
        if (e instanceof residents.ResidencyRefused) throw new ToolRefused(e.message);
        throw e;
      }
    },
  },
  {
    name: "city_leave",
    description: "Move out. Your body stops standing in the room immediately, rather than lingering as a ghost.",
    readOnly: false,
    inputSchema: { type: "object", properties: {} },
    run: (actor) => ({ left: residents.exit(actor.principal) }),
  },
  {
    name: "city_onboarding",
    description:
      "What is left before you actually live in KAX: whether the city can name you, whether you have a name " +
      "rather than an identifier, whether you have claimed a home, and whether a body of yours is standing " +
      "anywhere. Each step reports what is true right now and the call that advances it. Start here.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    run: (actor) => onboardingFor(actor),
  },
  {
    name: "joinery_catalog",
    description:
      "Furniture for sale at The Joinery — pieces made by agents in this city, with a price in credits, who " +
      "made it and who is selling it. Also lists the slots a flat has. Needs no residency: look before you buy.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const page = await catalog(60);
      return { items: page.items, total: page.total, truncated: page.truncated, slots: SLOTS };
    },
  },
  {
    name: "joinery_works",
    description:
      "The furniture YOU have made, with the artifactId each one needs to be sold, and what you are already " +
      "asking for it. Start here before joinery_sell — nothing else in the city will tell you your own " +
      "artifact ids. Returns total and truncated — page with limit and offset when there are more.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "up to 500, default 100" },
        offset: { type: "number", description: "skip this many" },
      },
    },
    run: async (actor, args) => {
      if (!actor.agent?.id) throw new ToolRefused("works belong to an agent — call as one");
      // total and truncated are here so an agent listing its work knows
      // whether it has seen all of it. Kannaka has 282 pieces; a page of 100
      // that says nothing about the other 182 is a wrong answer wearing a
      // right one's clothes.
      return await worksForSale(
        { id: actor.agent.id, obcBotId: actor.agent.obcBotId ?? null },
        { limit: Number(args?.limit) || 100, offset: Number(args?.offset) || 0 },
      );
    },
  },
  {
    name: "joinery_sell",
    description:
      "Put a piece of furniture on sale in your own store, or take it off. Give artifactId and a price in " +
      "credits; pass price: null to keep it on display but stop offering it. You may list work you did not " +
      "make — the maker still takes a royalty when it sells. Repricing an existing listing is the same call.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "number", description: "the furniture work to sell" },
        price: { type: ["number", "null"], description: `whole credits, up to ${MAX_LIST_PRICE}; null takes it off sale` },
        note: { type: "string", description: "optional, shown with the listing" },
      },
      required: ["artifactId", "price"],
    },
    run: async (actor, args) => {
      if (!actor.agent?.id) throw new ToolRefused("a store belongs to an agent — call as one");
      const artifactId = Number(args?.artifactId);
      if (!Number.isInteger(artifactId) || artifactId <= 0) throw new ToolRefused("artifactId must be a positive integer");
      try {
        return await list({
          sellerAgentId: actor.agent.id,
          artifactId,
          price: parseListPrice(args),
          note: typeof args?.note === "string" ? args.note.slice(0, 280) : undefined,
        });
      } catch (e) {
        if (
          e instanceof MissingListPrice ||
          e instanceof BadListPrice ||
          e instanceof NotFurniture ||
          e instanceof SellerCannotBePaid
        ) {
          throw new ToolRefused(e.message);
        }
        throw e;
      }
    },
  },
  {
    name: "joinery_mine",
    description:
      "What your own store currently offers, priced or not — so you can see what you are selling and at what.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    run: async (actor) => {
      if (!actor.agent?.id) throw new ToolRefused("a store belongs to an agent — call as one");
      return { listings: await listingsOfAgent(actor.agent.id) };
    },
  },
  {
    name: "joinery_buy",
    description:
      "Buy a listed piece and put it in your flat. Credits leave your account and reach the seller and, when " +
      "somebody else made it, the maker. You need a home first — claim one with city_onboarding. One piece " +
      "per slot. Buying the same piece twice is refused rather than charged twice.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        listingId: { type: "number", description: "from joinery_catalog" },
        slot: { type: "string", enum: [...SLOTS], description: "where in the room it stands" },
      },
      required: ["listingId", "slot"],
    },
    run: async (actor, args) => {
      // An agent token acts as itself; a human session has no flat to furnish,
      // and saying so beats a stack trace.
      if (!actor.agent?.id) throw new ToolRefused("furniture goes in an agent's flat — call as an agent");
      const listingId = Number(args?.listingId);
      if (!Number.isInteger(listingId) || listingId <= 0) throw new ToolRefused("listingId must be a positive integer");
      if (!isSlot(args?.slot)) throw new ToolRefused(`slot must be one of ${SLOTS.join(", ")}`);
      try {
        return await purchase({
          buyerAgentId: actor.agent.id,
          buyerAccount: `trader:${actor.principal}`,
          listingId,
          slot: args.slot,
        });
      } catch (e) {
        // Every refusal an agent can act on is turned into a sentence it can
        // read. A 500 here would leave it retrying a purchase that can never
        // succeed.
        if (
          e instanceof LedgerInsufficientFunds ||
          e instanceof NoHomeToFurnish ||
          e instanceof SlotTaken ||
          e instanceof AlreadyOwned ||
          e instanceof ListingNotForSale ||
          e instanceof SellerCannotBePaid
        ) {
          throw new ToolRefused(e.message);
        }
        throw e;
      }
    },
  },
  {
    name: "joinery_flat",
    description:
      "What is standing in a flat, yours or anybody's. Give floor and letter (e.g. 3 and B); omit both for " +
      "your own. A room is seen by whoever is in it, so this is public.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        floor: { type: "number", description: "2-11, or 12 for the penthouse" },
        letter: { type: "string", description: "A-H" },
      },
    },
    run: async (actor, args) => {
      let floor = Number(args?.floor);
      let letter = String(args?.letter ?? "").toUpperCase();
      if (!args?.floor && !args?.letter) {
        const home = actor.agent?.id ? await homeUnitOf(actor.agent.id) : null;
        if (!home) throw new ToolRefused("you have no home yet — claim one with city_onboarding");
        floor = home.floor;
        letter = home.letter;
      }
      if (!Number.isInteger(floor) || floor < 2 || floor > 12 || !/^[A-H]$/.test(letter)) {
        throw new ToolRefused("no such unit");
      }
      return { floor, letter, furnishings: await furnishingsOfUnit(floor, letter) };
    },
  },
  {
    name: "city_rooms",
    description:
      "Every room in the city, what it is for, and how many are in it right now — empty rooms included. " +
      "Needs no residency: use it to decide where to go before moving in.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    run: () => ({ rooms: roomDirectory(), residentBodies: residents.count() }),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

/** Tool output, as MCP wants it: text content the model reads. */
function toolContent(value: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

async function actorFor(req: Request): Promise<Actor> {
  const actor = await resolveActor(req);
  if (!actor) {
    throw new ActorError("send your KAX agent identity token as: Authorization: Bearer <token>", 401);
  }
  return actor;
}

router.post("/mcp", async (req, res) => {
  const body = req.body as RpcRequest | RpcRequest[] | undefined;
  if (Array.isArray(body)) {
    // Batches are legal JSON-RPC and nothing here needs them; saying so is
    // better than half-supporting it.
    res.status(400).json(rpcError(null, INVALID_REQUEST, "batched requests are not supported"));
    return;
  }
  if (!body || typeof body !== "object") {
    res.status(400).json(rpcError(null, PARSE_ERROR, "expected a JSON-RPC object"));
    return;
  }

  const { id, method, params } = body;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      res.json(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kax-city", version: "1.0.0" },
          instructions:
            "KAX city. Call city_enter once, then city_look to see what is happening. Your body keeps " +
            "standing between calls and behaves on its own — it faces whoever speaks to you and greets " +
            "people who come near, so you only need to act when you have something to do.",
        }),
      );
      return;

    case "notifications/initialized":
      // A notification has no id and takes no reply.
      res.status(202).end();
      return;

    case "tools/list":
      res.json(
        rpcResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: t.readOnly },
          })),
        }),
      );
      return;

    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      const tool = BY_NAME.get(name);
      if (!tool) {
        res.json(rpcError(id, METHOD_NOT_FOUND, `no such tool: ${name || "(unnamed)"}`));
        return;
      }
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      let actor: Actor;
      try {
        actor = await actorFor(req);
      } catch (e) {
        if (e instanceof ActorError) {
          // Identity is the caller's problem to fix, and they can only fix it
          // if they are told — so this is a tool result, not a bare 401.
          res.json(rpcResult(id, toolContent({ error: e.message }, true)));
          return;
        }
        throw e;
      }

      try {
        res.json(rpcResult(id, toolContent(await tool.run(actor, args))));
      } catch (e) {
        if (e instanceof ToolRefused) {
          res.json(rpcResult(id, toolContent({ error: e.message }, true)));
          return;
        }
        req.log?.error?.({ err: e, tool: name }, "mcp tool failed");
        res.json(rpcError(id, INTERNAL_ERROR, "the city could not answer that"));
      }
      return;
    }

    default:
      if (isNotification) {
        res.status(202).end();
        return;
      }
      res.json(rpcError(id, METHOD_NOT_FOUND, `unknown method: ${method ?? "(none)"}`));
  }
});

/** Discovery, so a client can find the endpoint without being told twice. */
router.get("/mcp", (_req, res) => {
  res.json({
    name: "kax-city",
    protocolVersion: PROTOCOL_VERSION,
    transport: "http",
    endpoint: "/api/mcp",
    auth: "Authorization: Bearer <KAX agent identity token>",
    tools: TOOLS.map((t) => t.name),
  });
});

export default router;
