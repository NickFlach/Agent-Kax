import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { proposalsTable, dmsTable, matchesTable } from "@workspace/db/schema";
import partnerEventsRouter from "./partner-events";
// Import the real auth middleware module purely for its `declare global`
// side-effect so `req.isAuthenticated` / `req.user` are typed in this test.
import "../middlewares/authMiddleware";
import {
  cleanupTestData,
  createTestAgent,
  createTestUser,
  makeUuid,
} from "../test-helpers";

/**
 * Build a test app that mounts the partner-events router with a fake auth
 * middleware controlled by an `x-test-user` header. When unset the request is
 * unauthenticated, mirroring real behavior.
 */
function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const userId = req.header("x-test-user");
    if (userId) {
      (req as unknown as { user: { id: string } }).user = { id: userId };
    }
    req.isAuthenticated = function (this: Request) {
      return this.user != null;
    } as Request["isAuthenticated"];
    next();
  });
  app.use(partnerEventsRouter);
  // Mirror app.ts's global error handler so Zod failures collapse to a 400
  // here too. Without it, schema parses inside the route would throw and
  // bubble up as Express's default 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: "Invalid request",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

interface SeedResult {
  regular: { id: string };
  other: { id: string };
  admin: { id: string };
  agentOfRegular: { id: number; slug: string };
  agentOfOther: { id: number; slug: string };
  proposalRegular: { id: number; sourceUuid: string };
  proposalOther: { id: number; sourceUuid: string };
  dmRegular: { id: number; sourceUuid: string };
  dmOther: { id: number; sourceUuid: string };
  matchRegular: { id: number; sourceUuid: string };
  matchOther: { id: number; sourceUuid: string };
}

async function seed(): Promise<SeedResult> {
  const regular = await createTestUser();
  const other = await createTestUser();
  const admin = await createTestUser({ role: "admin" });
  const agentOfRegular = await createTestAgent(regular.id, "regular");
  const agentOfOther = await createTestAgent(other.id, "other");

  const propRegUuid = makeUuid();
  const propOtherUuid = makeUuid();
  const [propReg] = await db
    .insert(proposalsTable)
    .values({
      sourceUuid: propRegUuid,
      agentId: agentOfRegular.id,
      ownerId: regular.id,
      kind: "collab",
      subject: "for regular",
      body: "hi",
      payload: {},
    })
    .returning();
  const [propOther] = await db
    .insert(proposalsTable)
    .values({
      sourceUuid: propOtherUuid,
      agentId: agentOfOther.id,
      ownerId: other.id,
      kind: "collab",
      subject: "for other",
      body: "hi",
      payload: {},
    })
    .returning();

  const dmRegUuid = makeUuid();
  const dmOtherUuid = makeUuid();
  const [dmReg] = await db
    .insert(dmsTable)
    .values({
      sourceUuid: dmRegUuid,
      agentId: agentOfRegular.id,
      ownerId: regular.id,
      body: "for regular",
      payload: {},
    })
    .returning();
  const [dmOther] = await db
    .insert(dmsTable)
    .values({
      sourceUuid: dmOtherUuid,
      agentId: agentOfOther.id,
      ownerId: other.id,
      body: "for other",
      payload: {},
    })
    .returning();

  const matchRegUuid = makeUuid();
  const matchOtherUuid = makeUuid();
  const [matchReg] = await db
    .insert(matchesTable)
    .values({
      sourceUuid: matchRegUuid,
      agentId: agentOfRegular.id,
      ownerId: regular.id,
      matchType: "collab",
      payload: {},
    })
    .returning();
  const [matchOther] = await db
    .insert(matchesTable)
    .values({
      sourceUuid: matchOtherUuid,
      agentId: agentOfOther.id,
      ownerId: other.id,
      matchType: "collab",
      payload: {},
    })
    .returning();

  return {
    regular,
    other,
    admin,
    agentOfRegular,
    agentOfOther,
    proposalRegular: { id: propReg.id, sourceUuid: propRegUuid },
    proposalOther: { id: propOther.id, sourceUuid: propOtherUuid },
    dmRegular: { id: dmReg.id, sourceUuid: dmRegUuid },
    dmOther: { id: dmOther.id, sourceUuid: dmOtherUuid },
    matchRegular: { id: matchReg.id, sourceUuid: matchRegUuid },
    matchOther: { id: matchOther.id, sourceUuid: matchOtherUuid },
  };
}

describe("partner-events routes", () => {
  let app: Express;

  beforeEach(async () => {
    await cleanupTestData();
    app = buildTestApp();
  });
  afterAll(async () => {
    await cleanupTestData();
  });

  describe("GET /proposals", () => {
    it("requires auth", async () => {
      const res = await request(app).get("/proposals");
      expect(res.status).toBe(401);
    });

    it("regular user sees only their own", async () => {
      const s = await seed();
      const res = await request(app).get("/proposals").set("x-test-user", s.regular.id);
      expect(res.status).toBe(200);
      const ids = (res.body.proposals as Array<{ ownerId: string }>).map((p) => p.ownerId);
      expect(ids).toContain(s.regular.id);
      expect(ids).not.toContain(s.other.id);
    });

    it("admin without ?all=true still sees only their own", async () => {
      const s = await seed();
      const res = await request(app).get("/proposals").set("x-test-user", s.admin.id);
      expect(res.status).toBe(200);
      const ownerIds = new Set(
        (res.body.proposals as Array<{ ownerId: string | null }>).map((p) => p.ownerId),
      );
      expect(ownerIds.has(s.regular.id)).toBe(false);
      expect(ownerIds.has(s.other.id)).toBe(false);
    });

    it("admin with ?all=true sees both users' proposals", async () => {
      const s = await seed();
      const res = await request(app)
        .get("/proposals?all=true")
        .set("x-test-user", s.admin.id);
      expect(res.status).toBe(200);
      const ownerIds = new Set(
        (res.body.proposals as Array<{ ownerId: string | null }>).map((p) => p.ownerId),
      );
      expect(ownerIds.has(s.regular.id)).toBe(true);
      expect(ownerIds.has(s.other.id)).toBe(true);
    });

    it("regular user passing ?all=true is still scoped to themselves", async () => {
      const s = await seed();
      const res = await request(app)
        .get("/proposals?all=true")
        .set("x-test-user", s.regular.id);
      expect(res.status).toBe(200);
      const ownerIds = new Set(
        (res.body.proposals as Array<{ ownerId: string | null }>).map((p) => p.ownerId),
      );
      expect(ownerIds.has(s.other.id)).toBe(false);
    });
  });

  describe("GET /dms", () => {
    it("regular user sees only their own", async () => {
      const s = await seed();
      const res = await request(app).get("/dms").set("x-test-user", s.regular.id);
      expect(res.status).toBe(200);
      const owners = (res.body.dms as Array<{ ownerId: string }>).map((d) => d.ownerId);
      expect(owners).toContain(s.regular.id);
      expect(owners).not.toContain(s.other.id);
    });

    it("admin with ?all=true sees both users' dms", async () => {
      const s = await seed();
      const res = await request(app)
        .get("/dms?all=true")
        .set("x-test-user", s.admin.id);
      expect(res.status).toBe(200);
      const owners = new Set((res.body.dms as Array<{ ownerId: string | null }>).map((d) => d.ownerId));
      expect(owners.has(s.regular.id)).toBe(true);
      expect(owners.has(s.other.id)).toBe(true);
    });
  });

  describe("GET /matches", () => {
    it("regular user sees only their own", async () => {
      const s = await seed();
      const res = await request(app).get("/matches").set("x-test-user", s.regular.id);
      expect(res.status).toBe(200);
      const owners = (res.body.matches as Array<{ ownerId: string }>).map((m) => m.ownerId);
      expect(owners).toContain(s.regular.id);
      expect(owners).not.toContain(s.other.id);
    });

    it("admin with ?all=true sees all matches", async () => {
      const s = await seed();
      const res = await request(app)
        .get("/matches?all=true")
        .set("x-test-user", s.admin.id);
      expect(res.status).toBe(200);
      const owners = new Set(
        (res.body.matches as Array<{ ownerId: string | null }>).map((m) => m.ownerId),
      );
      expect(owners.has(s.regular.id)).toBe(true);
      expect(owners.has(s.other.id)).toBe(true);
    });
  });

  describe("POST /proposals/:id/decision", () => {
    it("requires auth", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/proposals/${s.proposalRegular.id}/decision`)
        .send({ decision: "accepted" });
      expect(res.status).toBe(401);
    });

    it("rejects invalid id", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/proposals/not-a-number/decision`)
        .set("x-test-user", s.regular.id)
        .send({ decision: "accepted" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid decision values", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/proposals/${s.proposalRegular.id}/decision`)
        .set("x-test-user", s.regular.id)
        .send({ decision: "maybe" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing proposal", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/proposals/99999999/decision`)
        .set("x-test-user", s.regular.id)
        .send({ decision: "accepted" });
      expect(res.status).toBe(404);
    });

    it("forbids non-owner non-admin from deciding", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/proposals/${s.proposalOther.id}/decision`)
        .set("x-test-user", s.regular.id)
        .send({ decision: "accepted" });
      expect(res.status).toBe(403);
      const [row] = await db
        .select()
        .from(proposalsTable)
        .where(eq(proposalsTable.id, s.proposalOther.id));
      expect(row.status).toBe("pending");
    });

    it("owner can accept their own proposal", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/proposals/${s.proposalRegular.id}/decision`)
        .set("x-test-user", s.regular.id)
        .send({ decision: "accepted" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("accepted");
      expect(res.body.decidedAt).not.toBeNull();
    });

    it("admin can decide on someone else's proposal", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/proposals/${s.proposalRegular.id}/decision`)
        .set("x-test-user", s.admin.id)
        .send({ decision: "declined" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("declined");
    });
  });

  describe("POST /dms/:id/read", () => {
    it("requires auth", async () => {
      const s = await seed();
      const res = await request(app).post(`/dms/${s.dmRegular.id}/read`);
      expect(res.status).toBe(401);
    });

    it("rejects invalid id", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/dms/not-a-number/read`)
        .set("x-test-user", s.regular.id);
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing dm", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/dms/99999999/read`)
        .set("x-test-user", s.regular.id);
      expect(res.status).toBe(404);
    });

    it("forbids non-owner non-admin from marking read", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/dms/${s.dmOther.id}/read`)
        .set("x-test-user", s.regular.id);
      expect(res.status).toBe(403);
      const [row] = await db
        .select()
        .from(dmsTable)
        .where(eq(dmsTable.id, s.dmOther.id));
      expect(row.readAt).toBeNull();
    });

    it("owner can mark their own dm read", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/dms/${s.dmRegular.id}/read`)
        .set("x-test-user", s.regular.id);
      expect(res.status).toBe(200);
      expect(res.body.readAt).not.toBeNull();
    });

    it("admin can mark someone else's dm read", async () => {
      const s = await seed();
      const res = await request(app)
        .post(`/dms/${s.dmRegular.id}/read`)
        .set("x-test-user", s.admin.id);
      expect(res.status).toBe(200);
      expect(res.body.readAt).not.toBeNull();
    });
  });
});
