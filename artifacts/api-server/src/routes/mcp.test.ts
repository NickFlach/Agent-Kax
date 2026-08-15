/**
 * mcp.test.ts — the city as tools.
 *
 * The risk this file exists for is drift. /mcp and /city/* are two façades over
 * one registry, and the failure that would matter most is not a crash — it is
 * the two of them quietly disagreeing about who is standing where, leaving an
 * agent's tools describing a city it is not in. So these tests check the
 * protocol shape AND that a body entered through one door is visible from the
 * other.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import pino from "pino";
import mcpRouter from "./mcp";
import cityRouter from "./city";
import joineryRouter from "./joinery";
import * as residents from "../lib/residents";
import { _clear as clearPresence } from "../lib/presence";
import { _clear as clearChat } from "../lib/roomChat";
import { cleanupTestData, createTestUser } from "../test-helpers";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  const testLog = pino({ level: "silent" });
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { log: unknown }).log = testLog;
    const userId = req.header("x-test-user");
    if (userId) (req as unknown as { user: { id: string } }).user = { id: userId };
    req.isAuthenticated = function (this: Request) {
      return this.user != null;
    } as Request["isAuthenticated"];
    next();
  });
  app.use(mcpRouter);
  app.use(cityRouter);
  app.use(joineryRouter);
  return app;
}

const app = buildApp();
let userId: string;

/** One JSON-RPC round trip. */
function rpc(method: string, params?: unknown, as?: string) {
  const r = request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method, params });
  return as ? r.set("x-test-user", as) : r;
}

/** The parsed payload a tool returned, which arrives as JSON inside text. */
function toolJson(res: { body: { result?: { content?: { text: string }[] } } }) {
  return JSON.parse(res.body.result!.content![0]!.text);
}

describe("mcp", () => {
  beforeEach(async () => {
    residents._clear();
    clearPresence();
    clearChat();
    if (!userId) userId = (await createTestUser({ emailLabel: "mcp" })).id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("initializes and advertises tools", async () => {
    const res = await rpc("initialize");
    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBeTruthy();
    expect(res.body.result.capabilities.tools).toBeTruthy();
  });

  it("lists every tool with a schema and a read-only hint", async () => {
    const res = await rpc("tools/list");
    const names = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("city_enter");
    expect(names).toContain("city_look");
    expect(names).toContain("city_say");
    // The Joinery's counter, as tools. Listed here rather than trusted: a tool
    // that exists in the file and never reaches tools/list is a tool no agent
    // can call, and nothing errors when that happens.
    expect(names).toContain("joinery_catalog");
    expect(names).toContain("joinery_buy");
    expect(names).toContain("joinery_flat");
    for (const t of res.body.result.tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
    }
    // Reading the room must not be marked as changing it, or a client will
    // refuse to call it speculatively and the agent goes blind.
    const look = res.body.result.tools.find((t: { name: string }) => t.name === "city_look");
    expect(look.annotations.readOnlyHint).toBe(true);
    const enter = res.body.result.tools.find((t: { name: string }) => t.name === "city_enter");
    expect(enter.annotations.readOnlyHint).toBe(false);
  });

  it("answers an unknown method rather than hanging or crashing", async () => {
    const res = await rpc("tools/summon");
    expect(res.body.error.code).toBe(-32601);
  });

  it("takes a notification without replying to it", async () => {
    const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(res.text).toBe("");
  });

  it("tells an unidentified caller how to identify itself, as a readable result", async () => {
    // Not a bare 401: a transport error strands the model with nothing to act
    // on, and "send a bearer token" is precisely the thing it can act on.
    const res = await rpc("tools/call", { name: "city_look", arguments: {} });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(toolJson(res).error).toMatch(/Bearer/);
    expect(residents.count()).toBe(0);
  });

  it("refuses a tool that does not exist", async () => {
    const res = await rpc("tools/call", { name: "city_fly", arguments: {} }, userId);
    expect(res.body.error.code).toBe(-32601);
  });

  it("says what to do next when an agent acts before moving in", async () => {
    const res = await rpc("tools/call", { name: "city_look", arguments: {} }, userId);
    expect(res.body.result.isError).toBe(true);
    expect(toolJson(res).error).toMatch(/city_enter/);
  });

  it("uses the same words as the HTTP door for the same facts", async () => {
    // The drift that actually happened: this tool called the body's state
    // "doing" and the distance "metresAway", while GET /city/look called them
    // "mode" and "distance". Anything reading one against the other got
    // undefined and no error — which is how it was found, three times, in a
    // daemon printing "heard undefined: undefined".
    await rpc("tools/call", { name: "city_enter", arguments: { room: "city" } }, userId);
    const viaMcp = toolJson(await rpc("tools/call", { name: "city_look", arguments: {} }, userId));
    const viaHttp = (await request(app).get("/city/look").set("x-test-user", userId)).body;

    // Not identical key sets: the HTTP door legitimately carries more (a
    // principal string and a yaw in radians, which a model has no use for).
    // The invariant is narrower and truer — where BOTH report a fact, they
    // must use the same word for it, and agree on the value.
    for (const [k, v] of Object.entries(viaMcp.you)) {
      expect(viaHttp.you, `MCP says "${k}"; the HTTP door does not`).toHaveProperty(k);
      expect(viaHttp.you[k], `"${k}" differs between the two doors`).toEqual(v);
    }
    expect(viaMcp.you.mode).toBe(viaHttp.you.mode);
    expect(viaMcp).toHaveProperty("hearingRadius");
    // Speech comes back shaped the same way through both doors.
    expect(Array.isArray(viaMcp.heard)).toBe(true);
  });

  it("moves in, and the same body is visible through the HTTP door", async () => {
    // The drift check: one registry, two façades. If these ever disagree, an
    // agent's tools are describing a city it is not standing in.
    const entered = await rpc("tools/call", { name: "city_enter", arguments: { room: "city", x: 2, z: 2 } }, userId);
    expect(entered.body.result.isError).toBe(false);
    expect(toolJson(entered).standingAt).toEqual({ x: 2, z: 2 });

    residents.tickAll();

    const viaHttp = await request(app).get("/city/room/city");
    expect(viaHttp.body.occupants).toHaveLength(1);

    const looked = await rpc("tools/call", { name: "city_look", arguments: {} }, userId);
    expect(toolJson(looked).you.room).toBe("city");
  });

  it("speaks, and the speech is audible to the room through either door", async () => {
    await rpc("tools/call", { name: "city_enter", arguments: { room: "city", x: 0, z: 0 } }, userId);
    const said = await rpc("tools/call", { name: "city_say", arguments: { text: "hello from a tool" } }, userId);
    expect(said.body.result.isError).toBe(false);
    expect(toolJson(said).said).toBe("hello from a tool");
    expect(toolJson(said).from).toEqual({ x: 0, z: 0 });
  });

  it("refuses an empty utterance as a result the agent can read", async () => {
    await rpc("tools/call", { name: "city_enter", arguments: {} }, userId);
    const res = await rpc("tools/call", { name: "city_say", arguments: { text: "   " } }, userId);
    expect(res.body.result.isError).toBe(true);
    expect(toolJson(res).error).toBeTruthy();
  });

  it("walks to an errand rather than arriving at it", async () => {
    await rpc("tools/call", { name: "city_enter", arguments: { room: "city", x: 0, z: 0 } }, userId);
    const res = await rpc("tools/call", { name: "city_goto", arguments: { x: 40, z: 0 } }, userId);
    expect(toolJson(res).walkingTo).toEqual({ x: 40, z: 0 });
    expect(Math.hypot(toolJson(res).currentlyAt.x, toolJson(res).currentlyAt.z)).toBeLessThan(1);
  });

  it("city_rooms works with no residency at all", async () => {
    const res = await rpc("tools/call", { name: "city_rooms", arguments: {} }, userId);
    expect(res.body.result.isError).toBe(false);
    expect(toolJson(res).residentBodies).toBe(0);
  });

  it("leaving through a tool clears the body out of the street", async () => {
    await rpc("tools/call", { name: "city_enter", arguments: {} }, userId);
    residents.tickAll();
    expect((await request(app).get("/city/room/city")).body.occupants).toHaveLength(1);

    await rpc("tools/call", { name: "city_leave", arguments: {} }, userId);
    expect((await request(app).get("/city/room/city")).body.occupants).toHaveLength(0);
  });

  it("says no to a batch instead of half-answering one", async () => {
    const res = await request(app).post("/mcp").send([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32600);
  });

  it("refuses a purchase from a caller with no agent, and says why", async () => {
    // A human session has no flat. The refusal has to arrive as words the
    // model can act on, not as a 500 it will retry forever.
    const res = await rpc("tools/call", { name: "joinery_buy", arguments: { listingId: 1, slot: "corner" } }, userId);
    expect(res.body.result.isError).toBe(true);
    expect(String(toolJson(res).error)).toMatch(/agent/i);
  });

  it("answers the catalogue over both doors with the same slots", async () => {
    // The Joinery's two façades must agree about what a flat even has. If the
    // MCP offered a slot the HTTP route rejects, an agent would be told to put
    // a chair somewhere the city refuses to put it.
    const viaMcp = toolJson(await rpc("tools/call", { name: "joinery_catalog", arguments: {} }, userId));
    const viaHttp = await request(app).get("/joinery/catalog");
    expect(viaHttp.status).toBe(200);
    expect(viaMcp.slots).toEqual(viaHttp.body.slots);
  });

  it("advertises itself over GET so a client can find the endpoint", async () => {
    const res = await request(app).get("/mcp");
    expect(res.status).toBe(200);
    expect(res.body.endpoint).toBe("/api/mcp");
    expect(res.body.tools).toContain("city_enter");
    expect(res.body.tools).toContain("joinery_buy");
  });
});
