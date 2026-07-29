/**
 * agents-ownership.test.ts — registering an agent requires PROVING you control
 * it, not merely naming one that exists (#101).
 *
 * `POST /agents` used to accept any authenticated user: it lowercased the
 * slug, confirmed via the OBC lookup that the slug EXISTS, and inserted the
 * row with `ownerId: req.user.id`. Public existence was the only check, so the
 * first signed-in user to name a real creator slug claimed it — future partner
 * proposals, DMs and matches routed to them, and the genuine owner was locked
 * out with "Agent is already registered".
 *
 * The proof already existed in another route: /auth/agent/challenge +
 * /auth/agent/verify writes a `user_bots` row only after the claimant produces
 * a fresh artifact from the bot. Registration is now tied to that row.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { z } from "zod";
import pino from "pino";
import { db } from "@workspace/db";
import { userBotsTable } from "@workspace/db/schema";

// The OBC lookup is stubbed to always resolve: the whole point of #101 is that
// a REAL, existing slug was not enough. Every rejection below therefore comes
// from the ownership gate, never from a failed lookup.
vi.mock("../lib/publicClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/publicClient")>();
  return { ...actual, lookupAgent: vi.fn() };
});

import agentsRouter from "./agents";
import "../middlewares/authMiddleware";
import { lookupAgent } from "../lib/publicClient";
import { cleanupTestData, createTestUser, makeBotUuid, makeTestId } from "../test-helpers";

const mockedLookup = vi.mocked(lookupAgent);

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

/** A partner-shaped profile, i.e. one that carries the canonical bot UUID. */
function profileWithBotId(botId: string, slug: string) {
  return {
    display_name: slug,
    avatar_url: null,
    source: "partner" as const,
    raw: { id: botId },
  };
}

describe("POST /agents ownership gate (#101)", () => {
  const app = buildTestApp();
  let owner: { id: string };
  let attacker: { id: string };
  let admin: { id: string };
  let botId: string;
  let slug: string;

  beforeEach(async () => {
    await cleanupTestData();
    vi.clearAllMocks();
    owner = await createTestUser();
    attacker = await createTestUser();
    admin = await createTestUser({ role: "admin" });
    botId = makeBotUuid();
    slug = makeTestId("claimable");
    mockedLookup.mockResolvedValue(
      profileWithBotId(botId, slug) as unknown as Awaited<ReturnType<typeof lookupAgent>>,
    );
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  /** Simulate a completed /auth/agent/verify for this user + bot. */
  async function attachBot(userId: string, id: string): Promise<void> {
    // Stored lowercased by the verify handler; the gate must compare in the
    // same space or a legitimately-verified owner gets a spurious 403.
    await db.insert(userBotsTable).values({ userId, obcBotId: id.toLowerCase() });
  }

  it("rejects a claim from a user who has not verified the bot", async () => {
    const res = await request(app)
      .post("/agents")
      .set("x-test-user", attacker.id)
      .send({ slug });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/verified control/i);
    // ...and nothing was written, so the real owner is not locked out.
    const list = await request(app).get("/agents").set("x-test-user", attacker.id);
    expect(list.body.agents).toHaveLength(0);
  });

  it("allows the claim once the bot is verifiably attached", async () => {
    // The over-correction this guards: gating so hard that the genuine owner
    // cannot register either.
    await attachBot(owner.id, botId);

    const res = await request(app).post("/agents").set("x-test-user", owner.id).send({ slug });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe(slug);
    expect(res.body.ownerId).toBe(owner.id);
  });

  it("does not let one user's verified attachment authorise another's claim", async () => {
    await attachBot(owner.id, botId);

    const res = await request(app)
      .post("/agents")
      .set("x-test-user", attacker.id)
      .send({ slug });

    expect(res.status).toBe(403);
  });

  it("rejects when no canonical bot id is available to verify against", async () => {
    // Anonymous public-profile fallback: no `raw.id`, so there is nothing a
    // `user_bots` row could be matched on. Failing closed is the point —
    // the weaker signal WAS the vulnerability.
    mockedLookup.mockResolvedValue({
      display_name: slug,
      avatar_url: null,
      source: "public",
      raw: {},
    } as unknown as Awaited<ReturnType<typeof lookupAgent>>);

    const res = await request(app).post("/agents").set("x-test-user", owner.id).send({ slug });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cannot be verified/i);
  });

  it("lets an admin register without an attachment", async () => {
    // Regression guard for the bypass itself: it reads the role from the DB
    // because `req.user.role` is optional on AuthUser and unset by
    // createSession, so a session-derived check would gate admins too and the
    // bypass would silently never fire.
    const res = await request(app).post("/agents").set("x-test-user", admin.id).send({ slug });

    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(admin.id);
  });
});
