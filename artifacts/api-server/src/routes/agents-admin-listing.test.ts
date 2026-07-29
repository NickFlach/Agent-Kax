/**
 * agents-admin-listing.test.ts — the admin branch of GET /agents must actually
 * work, and must follow the live role (#137).
 *
 * `GET /agents` read `req.user.role` to decide between "all agents" and "only
 * mine". `req.user` is restored from the session payload and `AuthUser.role` is
 * OPTIONAL — nothing in the session-creation path populates it — so that
 * comparison was never true and the admin branch was dead code: an admin saw
 * only their own agents.
 *
 * Nothing caught it because the admin direction had no test at all. That is the
 * real gap: a dead permission branch is invisible until someone relies on it.
 *
 * The detail route had the same read and was fixed under #106, whose reasoning
 * also applies: an admin demoted to `user` kept cross-owner access until their
 * session expired. Both now resolve the role per request from the database.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import pino from "pino";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import agentsRouter from "./agents";
import "../middlewares/authMiddleware";
import { cleanupTestData, createTestAgent, createTestUser } from "../test-helpers";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  const testLog = pino({ level: "silent" });
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { log: unknown }).log = testLog;
    const userId = req.header("x-test-user");
    if (userId) {
      // Deliberately NO `role` here — this mirrors production, where the
      // session payload carries no role. A test that supplied one would hide
      // exactly the bug this file exists for.
      (req as unknown as { user: { id: string } }).user = { id: userId };
    }
    req.isAuthenticated = function (this: Request) {
      return this.user != null;
    } as Request["isAuthenticated"];
    next();
  });
  app.use(agentsRouter);
  return app;
}

describe("GET /agents admin listing (#137)", () => {
  const app = buildApp();
  let admin: { id: string };
  let owner: { id: string };
  let other: { id: string };

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: "admin" });
    owner = await createTestUser();
    other = await createTestUser();
    await createTestAgent(owner.id, "agent-of-owner");
    await createTestAgent(other.id, "agent-of-other");
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("an admin sees agents across all owners", async () => {
    // The dead branch. With the session-role read this returned 0 rows,
    // because the admin owns no agents of their own.
    const res = await request(app).get("/agents").set("x-test-user", admin.id);

    expect(res.status).toBe(200);
    const owners = new Set(res.body.agents.map((a: { ownerId: string }) => a.ownerId));
    expect(res.body.agents.length).toBeGreaterThanOrEqual(2);
    expect(owners.has(owner.id), "admin should see another user's agent").toBe(true);
    expect(owners.has(other.id), "admin should see a third user's agent").toBe(true);
  });

  it("a regular user still sees only their own", async () => {
    // The direction that must NOT change: fixing the admin branch by widening
    // the query for everyone would be a cross-tenant leak.
    const res = await request(app).get("/agents").set("x-test-user", owner.id);

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].ownerId).toBe(owner.id);
  });

  it("follows a demotion within the same session", async () => {
    // #106's reasoning: the role must be re-read per request, not trusted from
    // whatever the session was issued with.
    const before = await request(app).get("/agents").set("x-test-user", admin.id);
    expect(before.body.agents.length).toBeGreaterThanOrEqual(2);

    await db.update(usersTable).set({ role: "user" }).where(eq(usersTable.id, admin.id));

    const after = await request(app).get("/agents").set("x-test-user", admin.id);
    expect(after.status).toBe(200);
    expect(after.body.agents, "a demoted admin must lose cross-owner reads immediately")
      .toHaveLength(0);
  });

  it("follows a promotion within the same session", async () => {
    // The mirror case, and the one that proves the read is live rather than
    // merely re-derived once: a session issued as `user` must gain the admin
    // listing as soon as the row changes.
    const before = await request(app).get("/agents").set("x-test-user", owner.id);
    expect(before.body.agents).toHaveLength(1);

    await db.update(usersTable).set({ role: "admin" }).where(eq(usersTable.id, owner.id));

    const after = await request(app).get("/agents").set("x-test-user", owner.id);
    expect(after.body.agents.length).toBeGreaterThanOrEqual(2);
  });

  it("a disabled account is refused rather than served", async () => {
    // getOptionalAuth also rejects disabledAt, which the previous local helper
    // did not. requireAuth already covers this, so this pins the belt-and-braces
    // rather than a live hole.
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, admin.id));

    const res = await request(app).get("/agents").set("x-test-user", admin.id);
    expect(res.status).toBe(403);
  });
});
