/**
 * city.test.ts — the boundaries around living in the city.
 *
 * A residency is a body the server keeps standing, which makes these routes
 * more load-bearing than presence ever was: presence expired on its own after
 * twenty seconds, so a mistake there corrected itself. A resident persists.
 * So the checks that matter are who may occupy the city at all, and whether an
 * agent can be somewhere it is not.
 *
 * The express harness installs `isAuthenticated` deliberately. A bare app
 * without it makes `req.isAuthenticated()` throw, and a route that should
 * answer 401 answers 500 instead — which would turn "nobody is signed in" into
 * "the server is broken", and hide a missing session from exactly the test
 * written to catch it.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import pino from "pino";
import cityRouter from "./city";
import * as residents from "../lib/residents";
import { _clear as clearPresence } from "../lib/presence";
import { _clear as clearChat, CHAT_RADIUS } from "../lib/roomChat";
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
  app.use(cityRouter);
  return app;
}

const app = buildApp();
let userId: string;

describe("city routes", () => {
  beforeEach(async () => {
    residents._clear();
    clearPresence();
    clearChat();
    if (!userId) userId = (await createTestUser({ emailLabel: "city" })).id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("will not let an anonymous caller move in", async () => {
    const res = await request(app).post("/city/enter").send({ room: "city" });
    expect(res.status).toBe(401);
    expect(residents.count()).toBe(0);
  });

  it("will not let an anonymous caller look, speak, or be sent anywhere", async () => {
    for (const call of [
      request(app).get("/city/look"),
      request(app).post("/city/say").send({ text: "hello" }),
      request(app).post("/city/goto").send({ x: 1, z: 1 }),
      request(app).post("/city/leave"),
    ]) {
      expect((await call).status).toBe(401);
    }
  });

  it("refuses a room name that is not one", async () => {
    const res = await request(app).post("/city/enter").set("x-test-user", userId).send({ room: "../../etc" });
    expect(res.status).toBe(400);
    expect(residents.count()).toBe(0);
  });

  it("answers 409, not 500, when an agent acts before moving in", async () => {
    const look = await request(app).get("/city/look").set("x-test-user", userId);
    expect(look.status).toBe(409);
    const said = await request(app).post("/city/say").set("x-test-user", userId).send({ text: "hi" });
    expect(said.status).toBe(409);
  });

  it("refuses a room no scene renders, and says what does exist", async () => {
    // The failure this prevents: entering "atlantis" used to succeed. The body
    // would beat away, appear on its own roster, and be invisible forever,
    // because nothing renders that room so no browser asks who is in it.
    const res = await request(app).post("/city/enter").set("x-test-user", userId).send({ room: "atlantis" });
    expect(res.status).toBe(404);
    expect(res.body.rooms).toContain("cafe");
    expect(residents.count()).toBe(0);

    // A plausible-looking floor that does not exist is refused just as firmly.
    const ninetyNine = await request(app).post("/city/enter").set("x-test-user", userId).send({ room: "residences:99" });
    expect(ninetyNine.status).toBe(404);
  });

  it("lists every room including the empty ones", async () => {
    const res = await request(app).get("/city/rooms");
    expect(res.status).toBe(200);
    const ids = res.body.rooms.map((r: { id: string }) => r.id);
    expect(ids).toContain("cafe");
    expect(ids).toContain("residences:PH");
    // Each carries enough for an agent to choose without guessing.
    for (const r of res.body.rooms) {
      expect(typeof r.label).toBe("string");
      expect(typeof r.about).toBe("string");
      expect(typeof r.here).toBe("number");
    }
  });

  it("moves in, and says out loud how long the residency lasts", async () => {
    const res = await request(app).post("/city/enter").set("x-test-user", userId).send({ room: "city" });
    expect(res.status).toBe(200);
    expect(res.body.room).toBe("city");
    expect(res.body.residencyExpiresAfterIdleMs).toBe(residents.IDLE_MS);
    expect(residents.count()).toBe(1);
  });

  it("puts the body where the caller asked, not near it", async () => {
    // A body starts on its patrol ring, which is right for one that has always
    // been strolling and wrong for one that just arrived: entering at 5,-3 put
    // it a full six metres away, silently.
    const res = await request(app)
      .post("/city/enter")
      .set("x-test-user", userId)
      .send({ room: "city", x: 5, z: -3 });
    expect(res.status).toBe(200);
    expect(res.body.at.x).toBeCloseTo(5, 5);
    expect(res.body.at.z).toBeCloseTo(-3, 5);
  });

  it("speaks from where the body stands, not from wherever the caller claims", async () => {
    // The invariant that keeps the hearing radius meaningful: if a caller
    // could supply the position, an agent could whisper into a room it is
    // nowhere near, and distance would stop scoping conversation at all.
    await request(app).post("/city/enter").set("x-test-user", userId).send({ room: "city", x: 5, z: -3 });
    const res = await request(app)
      .post("/city/say")
      .set("x-test-user", userId)
      .send({ text: "from here", x: 900, z: 900 });

    expect(res.status).toBe(201);
    expect(res.body.from.x).toBeCloseTo(5, 1);
    expect(res.body.from.z).toBeCloseTo(-3, 1);
    expect(res.body.radius).toBe(CHAT_RADIUS);
  });

  it("reports the body walking to an errand rather than arriving at one", async () => {
    await request(app).post("/city/enter").set("x-test-user", userId).send({ room: "city", x: 0, z: 0 });
    const res = await request(app).post("/city/goto").set("x-test-user", userId).send({ x: 40, z: 0 });

    expect(res.status).toBe(200);
    expect(res.body.walkingTo).toEqual({ x: 40, z: 0 });
    // Still standing where it was — going somewhere takes time.
    expect(Math.hypot(res.body.from.x, res.body.from.z)).toBeLessThan(1);
  });

  it("lets anyone see into a room without an identity", async () => {
    await request(app).post("/city/enter").set("x-test-user", userId).send({ room: "city" });
    residents.tickAll();

    const res = await request(app).get("/city/room/city");
    expect(res.status).toBe(200);
    expect(res.body.occupants).toHaveLength(1);
    expect(res.body.occupants[0]).not.toHaveProperty("principal");
  });

  it("moving out empties the street", async () => {
    await request(app).post("/city/enter").set("x-test-user", userId).send({ room: "city" });
    residents.tickAll();

    const left = await request(app).post("/city/leave").set("x-test-user", userId);
    expect(left.status).toBe(200);
    expect(left.body.left).toBe(true);
    expect((await request(app).get("/city/room/city")).body.occupants).toHaveLength(0);
  });
});
