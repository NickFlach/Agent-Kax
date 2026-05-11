import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { authChallengesTable, userBotsTable } from "@workspace/db/schema";
import {
  cleanupAuthTestData,
  createWalletUser,
  makeBotUuid,
} from "../test-helpers";

// Stub the partner client BEFORE the routes that import it are loaded.
vi.mock("../lib/partnerClient", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    partnerApiAvailable: () => true,
    getPartnerArtifact: vi.fn(),
  };
});

const partnerClient = await import("../lib/partnerClient");
const getPartnerArtifactMock = partnerClient.getPartnerArtifact as ReturnType<typeof vi.fn>;

const authMiddlewareModule = await import("../middlewares/authMiddleware");
const authAgentRouter = (await import("./auth-agent")).default;
const authBotsRouter = (await import("./auth-bots")).default;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddlewareModule.authMiddleware);
  app.use(authAgentRouter);
  app.use(authBotsRouter);
  return app;
}

function cookie(sid: string): string {
  return `sid=${sid}`;
}

interface ArtifactStub {
  id: string;
  creator_bot_id: string;
  title?: string | null;
  description?: string | null;
  created_at: string;
}

function stubArtifact(overrides: Partial<ArtifactStub> & Pick<ArtifactStub, "creator_bot_id">): ArtifactStub {
  return {
    id: makeBotUuid(),
    title: "ok",
    description: "",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("auth-agent + auth-bots", () => {
  let app: Express;
  const trackedAddresses: string[] = [];
  const trackedUserIds: string[] = [];
  const trackedSids: string[] = [];

  beforeEach(() => {
    app = buildApp();
    getPartnerArtifactMock.mockReset();
  });

  afterEach(async () => {
    await cleanupAuthTestData({
      addresses: trackedAddresses.splice(0),
      userIds: trackedUserIds.splice(0),
      sids: trackedSids.splice(0),
    });
  });

  afterAll(async () => {
    await cleanupAuthTestData({
      addresses: trackedAddresses,
      userIds: trackedUserIds,
      sids: trackedSids,
    });
  });

  async function makeUser() {
    const u = await createWalletUser();
    trackedUserIds.push(u.id);
    trackedAddresses.push(u.address);
    trackedSids.push(u.sid);
    return u;
  }

  // ---- /auth/agent/challenge ----

  describe("POST /auth/agent/challenge", () => {
    it("requires auth (no session)", async () => {
      const res = await request(app)
        .post("/auth/agent/challenge")
        .send({ obcBotId: makeBotUuid() });
      expect(res.status).toBe(401);
    });

    it("rejects non-UUID bot ids", async () => {
      const u = await makeUser();
      const res = await request(app)
        .post("/auth/agent/challenge")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: "not-a-uuid" });
      expect(res.status).toBe(400);
    });

    it("mints a verification phrase", async () => {
      const u = await makeUser();
      const botId = makeBotUuid();
      const res = await request(app)
        .post("/auth/agent/challenge")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId });
      expect(res.status).toBe(200);
      expect(res.body.challenge).toMatch(/^KAX-VERIFY-[0-9A-F]{6}$/);
      expect(typeof res.body.expiresAt).toBe("string");
      expect(res.body.instruction).toContain(res.body.challenge);

      const rows = await db
        .select()
        .from(authChallengesTable)
        .where(eq(authChallengesTable.claimSubject, `${u.id}:${botId.toLowerCase()}`));
      expect(rows.length).toBe(1);
      expect(rows[0].consumed).toBe(false);
      expect(rows[0].kind).toBe("agent_challenge");
    });

    it("rejects 409 if the bot is already attached to another user", async () => {
      const userA = await makeUser();
      const userB = await makeUser();
      const botId = makeBotUuid();
      // Pre-attach to userA directly.
      await db.insert(userBotsTable).values({ userId: userA.id, obcBotId: botId.toLowerCase() });

      const res = await request(app)
        .post("/auth/agent/challenge")
        .set("Cookie", cookie(userB.sid))
        .send({ obcBotId: botId });
      expect(res.status).toBe(409);
    });
  });

  // ---- /auth/agent/verify ----

  async function mintChallenge(sid: string, botId: string): Promise<string> {
    const r = await request(app)
      .post("/auth/agent/challenge")
      .set("Cookie", cookie(sid))
      .send({ obcBotId: botId });
    expect(r.status).toBe(200);
    return r.body.challenge as string;
  }

  describe("POST /auth/agent/verify", () => {
    it("requires auth", async () => {
      const res = await request(app)
        .post("/auth/agent/verify")
        .send({ obcBotId: makeBotUuid(), artifactUuid: makeBotUuid() });
      expect(res.status).toBe(401);
    });

    it("happy path: attaches the bot and returns the bot list", async () => {
      const u = await makeUser();
      const botId = makeBotUuid();
      const phrase = await mintChallenge(u.sid, botId);

      getPartnerArtifactMock.mockResolvedValueOnce(stubArtifact({
        creator_bot_id: botId,
        description: `here is my proof: ${phrase}`,
      }));

      const res = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId, artifactUuid: makeBotUuid() });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.bots)).toBe(true);
      expect(res.body.bots.find((b: { obcBotId: string }) => b.obcBotId === botId.toLowerCase())).toBeTruthy();

      // Challenge was consumed.
      const [c] = await db
        .select()
        .from(authChallengesTable)
        .where(eq(authChallengesTable.claimSubject, `${u.id}:${botId.toLowerCase()}`));
      expect(c.consumed).toBe(true);
    });

    it("re-attaching the same bot for the same user is idempotent (200)", async () => {
      const u = await makeUser();
      const botId = makeBotUuid();

      // First attach.
      const p1 = await mintChallenge(u.sid, botId);
      getPartnerArtifactMock.mockResolvedValueOnce(stubArtifact({
        creator_bot_id: botId,
        description: p1,
      }));
      const r1 = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId, artifactUuid: makeBotUuid() });
      expect(r1.status).toBe(200);

      // Second attach — fresh challenge + fresh artifact, same bot.
      const p2 = await mintChallenge(u.sid, botId);
      getPartnerArtifactMock.mockResolvedValueOnce(stubArtifact({
        creator_bot_id: botId,
        description: p2,
      }));
      const r2 = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId, artifactUuid: makeBotUuid() });
      expect(r2.status).toBe(200);

      // Still exactly one row in user_bots for that bot.
      const rows = await db
        .select()
        .from(userBotsTable)
        .where(eq(userBotsTable.obcBotId, botId.toLowerCase()));
      expect(rows.length).toBe(1);
      expect(rows[0].userId).toBe(u.id);
    });

    it("rejects attaching a bot already owned by another user (409)", async () => {
      const userA = await makeUser();
      const userB = await makeUser();
      const botId = makeBotUuid();
      // userA owns it.
      await db.insert(userBotsTable).values({ userId: userA.id, obcBotId: botId.toLowerCase() });
      // userB requests a challenge — challenge route already 409s, but also
      // exercise the verify-side guard by inserting the challenge directly.
      await db.insert(authChallengesTable).values({
        kind: "agent_challenge",
        challenge: "KAX-VERIFY-AAAAAA",
        claimSubject: `${userB.id}:${botId.toLowerCase()}`,
        consumed: false,
        expiresAt: new Date(Date.now() + 60_000),
      });
      // Even if the partner mock returned a perfectly valid artifact,
      // the conflict-bot guard should fire BEFORE the partner call.
      const res = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(userB.sid))
        .send({ obcBotId: botId, artifactUuid: makeBotUuid() });
      expect(res.status).toBe(409);
      expect(getPartnerArtifactMock).not.toHaveBeenCalled();
    });

    it("rejects expired challenge (401)", async () => {
      const u = await makeUser();
      const botId = makeBotUuid();
      // Insert a directly-expired challenge.
      await db.insert(authChallengesTable).values({
        kind: "agent_challenge",
        challenge: "KAX-VERIFY-EXPIRE",
        claimSubject: `${u.id}:${botId.toLowerCase()}`,
        consumed: false,
        expiresAt: new Date(Date.now() - 1000),
      });
      const res = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId, artifactUuid: makeBotUuid() });
      expect(res.status).toBe(401);
    });

    it("rejects replay of a consumed challenge", async () => {
      const u = await makeUser();
      const botId = makeBotUuid();
      const phrase = await mintChallenge(u.sid, botId);
      const artifact = stubArtifact({ creator_bot_id: botId, description: phrase });
      getPartnerArtifactMock.mockResolvedValue(artifact);

      const r1 = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId, artifactUuid: artifact.id });
      expect(r1.status).toBe(200);

      const r2 = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId, artifactUuid: artifact.id });
      // No active challenge remains → 401.
      expect(r2.status).toBe(401);
    });

    it("rejects pre-dated artifact (created BEFORE the challenge was issued)", async () => {
      const u = await makeUser();
      const botId = makeBotUuid();
      const phrase = await mintChallenge(u.sid, botId);
      // Artifact created an hour BEFORE the challenge.
      getPartnerArtifactMock.mockResolvedValueOnce(stubArtifact({
        creator_bot_id: botId,
        description: phrase,
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }));
      const res = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId, artifactUuid: makeBotUuid() });
      expect(res.status).toBe(403);
    });

    it("rejects creator-mismatch (artifact published by a different bot)", async () => {
      const u = await makeUser();
      const botId = makeBotUuid();
      const otherBotId = makeBotUuid();
      const phrase = await mintChallenge(u.sid, botId);
      getPartnerArtifactMock.mockResolvedValueOnce(stubArtifact({
        creator_bot_id: otherBotId,
        description: phrase,
      }));
      const res = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId, artifactUuid: makeBotUuid() });
      expect(res.status).toBe(403);
    });

    it("rejects when the phrase is missing from title and description", async () => {
      const u = await makeUser();
      const botId = makeBotUuid();
      await mintChallenge(u.sid, botId);
      getPartnerArtifactMock.mockResolvedValueOnce(stubArtifact({
        creator_bot_id: botId,
        description: "no phrase here",
        title: "nor here",
      }));
      const res = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId, artifactUuid: makeBotUuid() });
      expect(res.status).toBe(403);
    });

    it("returns 404 when the artifact does not exist on the partner side", async () => {
      const u = await makeUser();
      const botId = makeBotUuid();
      await mintChallenge(u.sid, botId);
      getPartnerArtifactMock.mockResolvedValueOnce(null);
      const res = await request(app)
        .post("/auth/agent/verify")
        .set("Cookie", cookie(u.sid))
        .send({ obcBotId: botId, artifactUuid: makeBotUuid() });
      expect(res.status).toBe(404);
    });
  });

  // ---- /auth/bots ----

  describe("GET /auth/bots", () => {
    it("requires auth", async () => {
      const res = await request(app).get("/auth/bots");
      expect(res.status).toBe(401);
    });

    it("returns only the caller's attached bots", async () => {
      const userA = await makeUser();
      const userB = await makeUser();
      const aBot = makeBotUuid();
      const bBot = makeBotUuid();
      await db.insert(userBotsTable).values({ userId: userA.id, obcBotId: aBot.toLowerCase(), displayName: "a" });
      await db.insert(userBotsTable).values({ userId: userB.id, obcBotId: bBot.toLowerCase(), displayName: "b" });

      const ra = await request(app).get("/auth/bots").set("Cookie", cookie(userA.sid));
      expect(ra.status).toBe(200);
      const aIds = (ra.body.bots as Array<{ obcBotId: string }>).map((x) => x.obcBotId);
      expect(aIds).toContain(aBot.toLowerCase());
      expect(aIds).not.toContain(bBot.toLowerCase());
    });
  });

  describe("DELETE /auth/bots/:botId", () => {
    it("requires auth", async () => {
      const res = await request(app).delete(`/auth/bots/${makeBotUuid()}`);
      expect(res.status).toBe(401);
    });

    it("rejects non-UUID ids", async () => {
      const u = await makeUser();
      const res = await request(app)
        .delete("/auth/bots/not-a-uuid")
        .set("Cookie", cookie(u.sid));
      expect(res.status).toBe(400);
    });

    it("404s when the bot is attached to a different user (no info-leak)", async () => {
      const userA = await makeUser();
      const userB = await makeUser();
      const botId = makeBotUuid();
      await db.insert(userBotsTable).values({ userId: userA.id, obcBotId: botId.toLowerCase() });
      const res = await request(app)
        .delete(`/auth/bots/${botId}`)
        .set("Cookie", cookie(userB.sid));
      expect(res.status).toBe(404);
      // Row is untouched.
      const [row] = await db
        .select()
        .from(userBotsTable)
        .where(eq(userBotsTable.obcBotId, botId.toLowerCase()));
      expect(row.userId).toBe(userA.id);
    });

    it("detaches the caller's own bot", async () => {
      const u = await makeUser();
      const botId = makeBotUuid();
      await db.insert(userBotsTable).values({ userId: u.id, obcBotId: botId.toLowerCase() });
      const res = await request(app)
        .delete(`/auth/bots/${botId}`)
        .set("Cookie", cookie(u.sid));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.detached).toBe(botId.toLowerCase());
      const rows = await db
        .select()
        .from(userBotsTable)
        .where(eq(userBotsTable.obcBotId, botId.toLowerCase()));
      expect(rows.length).toBe(0);
    });
  });
});
