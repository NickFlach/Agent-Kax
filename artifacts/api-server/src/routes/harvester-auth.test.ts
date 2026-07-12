import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { z } from "zod";
import pino from "pino";

// ---- Mocks (hoisted by vitest) ---------------------------------------------

vi.mock("../lib/partnerClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/partnerClient")>();
  return {
    ...actual,
    partnerApiAvailable: vi.fn(() => true),
    hasPartnerBudgetHeadroom: vi.fn(async () => true),
  };
});

vi.mock("../lib/harvesterJob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/harvesterJob")>();
  return {
    ...actual,
    // manualHarvestCooldown stays REAL so the cooldown behavior is exercised;
    // the run itself and the in-flight probe are controlled per-test.
    runPartnerHarvest: vi.fn(),
    harvestInFlight: vi.fn(() => false),
  };
});

vi.mock("../lib/registryHarvest", () => ({
  runRegistryHarvest: vi.fn(async () => ({
    totalHarvested: 0,
    totalNew: 0,
    totalDuplicates: 0,
    perConnector: [],
  })),
}));

vi.mock("../lib/constellationBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/constellationBridge")>();
  return { ...actual, publish: vi.fn(async () => {}) };
});

import harvesterRouter from "./harvester";
import agentsRouter from "./agents";
import "../middlewares/authMiddleware";
import { partnerApiAvailable, hasPartnerBudgetHeadroom } from "../lib/partnerClient";
import {
  runPartnerHarvest,
  harvestInFlight,
  manualHarvestCooldown,
  type HarvestRunResult,
} from "../lib/harvesterJob";
import { cleanupTestData, createTestAgent, createTestUser } from "../test-helpers";

const mockedAvailable = vi.mocked(partnerApiAvailable);
const mockedHeadroom = vi.mocked(hasPartnerBudgetHeadroom);
const mockedRun = vi.mocked(runPartnerHarvest);
const mockedInFlight = vi.mocked(harvestInFlight);

function makeResult(overrides: Partial<HarvestRunResult> = {}): HarvestRunResult {
  return {
    harvested: 10,
    newArtifacts: 4,
    duplicates: 6,
    perOwnerNew: {},
    perAgentNew: {},
    ...overrides,
  };
}

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  const testLog = pino({ level: "silent" });
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { log: unknown }).log = testLog;
    const userId = req.header("x-test-user");
    if (userId) {
      (req as unknown as { user: { id: string } }).user = { id: userId };
    }
    req.isAuthenticated = function (this: Request) {
      return this.user != null;
    } as Request["isAuthenticated"];
    next();
  });
  app.use(harvesterRouter);
  app.use(agentsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  });
  return app;
}

describe("harvest access control", () => {
  const app = buildTestApp();
  let regular: { id: string };
  let other: { id: string };
  let admin: { id: string };
  let agentOfRegular: { id: number; slug: string };
  let agentOfOther: { id: number; slug: string };

  beforeEach(async () => {
    await cleanupTestData();
    manualHarvestCooldown.reset();
    vi.clearAllMocks();
    mockedAvailable.mockReturnValue(true);
    mockedHeadroom.mockResolvedValue(true);
    mockedInFlight.mockReturnValue(false);
    mockedRun.mockResolvedValue(makeResult());

    regular = await createTestUser();
    other = await createTestUser();
    admin = await createTestUser({ role: "admin" });
    agentOfRegular = await createTestAgent(regular.id, "harv-reg");
    agentOfOther = await createTestAgent(other.id, "harv-other");
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("POST /harvester/run", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await request(app).post("/harvester/run").send({ type: "image" });
      expect(res.status).toBe(401);
      expect(mockedRun).not.toHaveBeenCalled();
    });

    it("lets a regular user run a harvest and returns their owner-scoped count", async () => {
      mockedRun.mockResolvedValue(
        makeResult({ newArtifacts: 5, perOwnerNew: { [regular.id]: 2 } }),
      );
      const res = await request(app)
        .post("/harvester/run")
        .set("x-test-user", regular.id)
        .send({ type: "image" });
      expect(res.status).toBe(200);
      expect(res.body.newArtifacts).toBe(5);
      expect(res.body.yourNewArtifacts).toBe(2);
      // Non-admin triggers must never run the cross-tenant audio pairing.
      expect(res.body.paired).toBe(0);
    });

    it("enforces the 10-minute cooldown for non-admin fresh runs", async () => {
      const first = await request(app)
        .post("/harvester/run")
        .set("x-test-user", regular.id)
        .send({ type: "image" });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post("/harvester/run")
        .set("x-test-user", regular.id)
        .send({ type: "image" });
      expect(second.status).toBe(429);
      expect(second.body.error).toMatch(/cooldown/i);
      expect(mockedRun).toHaveBeenCalledTimes(1);
    });

    it("does not charge the cooldown when joining an in-flight run", async () => {
      mockedInFlight.mockReturnValue(true);
      const join1 = await request(app)
        .post("/harvester/run")
        .set("x-test-user", regular.id)
        .send({ type: "image" });
      const join2 = await request(app)
        .post("/harvester/run")
        .set("x-test-user", regular.id)
        .send({ type: "image" });
      expect(join1.status).toBe(200);
      expect(join2.status).toBe(200);

      // After the run finishes, the user can still start a fresh one:
      // no cooldown was charged for the joins.
      mockedInFlight.mockReturnValue(false);
      const fresh = await request(app)
        .post("/harvester/run")
        .set("x-test-user", regular.id)
        .send({ type: "image" });
      expect(fresh.status).toBe(200);
    });

    it("does not burn the cooldown when the harvest run fails", async () => {
      mockedRun.mockRejectedValueOnce(new Error("partner API is down"));
      const failed = await request(app)
        .post("/harvester/run")
        .set("x-test-user", regular.id)
        .send({ type: "image" });
      expect(failed.status).toBe(500);

      // The failed attempt cleared the cooldown, so a retry works immediately.
      const retry = await request(app)
        .post("/harvester/run")
        .set("x-test-user", regular.id)
        .send({ type: "image" });
      expect(retry.status).toBe(200);
      expect(mockedRun).toHaveBeenCalledTimes(2);
    });

    it("does not apply the cooldown to admins", async () => {
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post("/harvester/run")
          .set("x-test-user", admin.id)
          .send({ type: "image" });
        expect(res.status).toBe(200);
      }
      expect(mockedRun).toHaveBeenCalledTimes(3);
    });

    it("returns 429 for everyone (admins included) when the partner budget is exhausted", async () => {
      mockedHeadroom.mockResolvedValue(false);
      const res = await request(app)
        .post("/harvester/run")
        .set("x-test-user", admin.id)
        .send({ type: "image" });
      expect(res.status).toBe(429);
      expect(res.body.error).toMatch(/budget/i);
      expect(mockedRun).not.toHaveBeenCalled();
    });

    it("returns 503 for non-admins when the partner API is not configured (registry fallback is admin-only)", async () => {
      mockedAvailable.mockReturnValue(false);
      const res = await request(app)
        .post("/harvester/run")
        .set("x-test-user", regular.id)
        .send({ type: "image" });
      expect(res.status).toBe(503);
      expect(mockedRun).not.toHaveBeenCalled();
    });

    it("lets admins use the registry fallback when the partner API is not configured", async () => {
      mockedAvailable.mockReturnValue(false);
      const res = await request(app)
        .post("/harvester/run")
        .set("x-test-user", admin.id)
        .send({ type: "image" });
      expect(res.status).toBe(200);
      expect(mockedRun).not.toHaveBeenCalled();
    });
  });

  describe("POST /agents/:slug/harvest", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await request(app)
        .post(`/agents/${agentOfRegular.slug}/harvest`)
        .send({});
      expect(res.status).toBe(401);
    });

    it("returns 404 for an unknown agent", async () => {
      const res = await request(app)
        .post("/agents/kax-test-does-not-exist/harvest")
        .set("x-test-user", regular.id)
        .send({});
      expect(res.status).toBe(404);
    });

    it("forbids harvesting someone else's agent", async () => {
      const res = await request(app)
        .post(`/agents/${agentOfOther.slug}/harvest`)
        .set("x-test-user", regular.id)
        .send({});
      expect(res.status).toBe(403);
      expect(mockedRun).not.toHaveBeenCalled();
    });

    it("lets an owner harvest their own agent with owner- and agent-scoped counts", async () => {
      mockedRun.mockResolvedValue(
        makeResult({
          newArtifacts: 7,
          perOwnerNew: { [regular.id]: 3 },
          perAgentNew: { [String(agentOfRegular.id)]: 2 },
        }),
      );
      const res = await request(app)
        .post(`/agents/${agentOfRegular.slug}/harvest`)
        .set("x-test-user", regular.id)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.yourNewArtifacts).toBe(3);
      expect(res.body.agentNewArtifacts).toBe(2);
    });

    it("lets an admin harvest any agent", async () => {
      const res = await request(app)
        .post(`/agents/${agentOfOther.slug}/harvest`)
        .set("x-test-user", admin.id)
        .send({});
      expect(res.status).toBe(200);
    });

    it("returns 429 when the partner budget is exhausted", async () => {
      mockedHeadroom.mockResolvedValue(false);
      const res = await request(app)
        .post(`/agents/${agentOfRegular.slug}/harvest`)
        .set("x-test-user", regular.id)
        .send({});
      expect(res.status).toBe(429);
      expect(mockedRun).not.toHaveBeenCalled();
    });

    it("shares the cooldown with /harvester/run for the same user", async () => {
      const first = await request(app)
        .post("/harvester/run")
        .set("x-test-user", regular.id)
        .send({ type: "image" });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post(`/agents/${agentOfRegular.slug}/harvest`)
        .set("x-test-user", regular.id)
        .send({});
      expect(second.status).toBe(429);
      expect(mockedRun).toHaveBeenCalledTimes(1);
    });
  });
});
