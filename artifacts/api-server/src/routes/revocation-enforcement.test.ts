/**
 * revocation-enforcement.test.ts — a revoked bot must not be able to get a
 * fresh credential, and its owner must not be able to act for it.
 *
 * `revoke()` sets `revoked_at` and detaches nothing, which is the right shape:
 * a suspension is not a demolition. But it meant every gate that asked only
 * "is there a user_bots row?" answered yes for a bot the city had already
 * disowned. Two of those gates minted credentials — /auth/token every fifteen
 * minutes, /auth/token/refresh for up to a month of lineage — and a third,
 * agentForActor, let a signed-in owner keep acting on the agent's behalf. The
 * one gate that did check, resolveActor, only covered the agent's own token,
 * so the freeze was real from one direction and cosmetic from the other.
 *
 * These tests come in pairs on purpose: each refusal is preceded by the same
 * request succeeding, so a test that stops proving anything fails loudly
 * instead of passing vacuously. The last group holds the reverse property —
 * restoring gives everything back, because nothing was destroyed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { eq } from "drizzle-orm";
import { generateKeyPair, exportJWK } from "jose";
import { db } from "@workspace/db";
import { agentsTable, userBotsTable } from "@workspace/db/schema";
import identityRouter from "./identity";
import authBotsRouter from "./auth-bots";
import { authMiddleware } from "../middlewares/authMiddleware";
import { resolveActor, agentForActor, ActorError } from "../lib/actor";
import { revoke, restore } from "../lib/revocation";
import { _resetKeyCache } from "../lib/identity";
import {
  cleanupAuthTestData,
  createWalletUser,
  makeBotUuid,
  makeTestId,
} from "../test-helpers";

/**
 * Mirrors how the real server is assembled, plus one test-only route that
 * calls resolveActor → agentForActor exactly the way /residences/claim does.
 * Going through a route rather than calling the function bare keeps the
 * session, the middleware and the ActorError→status mapping in the picture,
 * which is where the owner-side gate actually has to hold.
 */
function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(identityRouter);
  // Detach is mounted because a revocation lives on the row detach removes, so
  // the freeze and the attachment-management surface have to be tested against
  // each other rather than each on its own.
  app.use(authBotsRouter);
  app.post("/test/act-for-agent", async (req, res) => {
    const body = (req.body ?? {}) as { agentId?: unknown };
    try {
      const actor = await resolveActor(req);
      if (!actor) {
        res.status(401).json({ error: "sign in, or send an agent identity token" });
        return;
      }
      const agent = await agentForActor(actor, req, body.agentId);
      res.json({ agentId: agent.id });
    } catch (e) {
      if (e instanceof ActorError) {
        res.status(e.status).json({ error: e.message });
        return;
      }
      throw e;
    }
  });
  return app;
}

function cookie(sid: string): string {
  return `sid=${sid}`;
}

describe("revocation enforcement", () => {
  const app = makeApp();
  const trackedAddresses: string[] = [];
  const trackedUserIds: string[] = [];
  const trackedSids: string[] = [];

  let owner: { id: string; address: string; sid: string };
  let botId: string;
  let otherBotId: string;
  let agentId: number;
  let priorJwk: string | undefined;

  beforeAll(async () => {
    // Issuing fails closed with no signing key, and a 503 would make every
    // assertion below pass for the wrong reason.
    priorJwk = process.env.KAX_IDENTITY_PRIVATE_JWK;
    const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    process.env.KAX_IDENTITY_PRIVATE_JWK = JSON.stringify(await exportJWK(privateKey));
    _resetKeyCache();
  });

  afterAll(async () => {
    if (priorJwk === undefined) delete process.env.KAX_IDENTITY_PRIVATE_JWK;
    else process.env.KAX_IDENTITY_PRIVATE_JWK = priorJwk;
    _resetKeyCache();
    await cleanupAuthTestData({
      addresses: trackedAddresses,
      userIds: trackedUserIds,
      sids: trackedSids,
    });
  });

  beforeEach(async () => {
    owner = await createWalletUser();
    trackedUserIds.push(owner.id);
    trackedAddresses.push(owner.address);
    trackedSids.push(owner.sid);

    botId = makeBotUuid();
    otherBotId = makeBotUuid();
    await db.insert(userBotsTable).values([
      { userId: owner.id, obcBotId: botId, displayName: "Revocable" },
      { userId: owner.id, obcBotId: otherBotId, displayName: "Innocent Bystander" },
    ]);

    const [agent] = await db
      .insert(agentsTable)
      .values({
        slug: makeTestId("revoked-agent"),
        displayName: "Revocable",
        obcBotId: botId,
        ownerId: owner.id,
      })
      .returning();
    agentId = agent!.id;
  });

  afterEach(async () => {
    // agents and user_bots both cascade from users, so dropping the owner is
    // enough — but do it per-test so each case starts from a clean attachment.
    await cleanupAuthTestData({
      addresses: trackedAddresses.splice(0),
      userIds: trackedUserIds.splice(0),
      sids: trackedSids.splice(0),
    });
  });

  function mint(bot: string) {
    return request(app).post("/auth/token").set("Cookie", cookie(owner.sid)).send({ obcBotId: bot });
  }

  function actForAgent() {
    return request(app)
      .post("/test/act-for-agent")
      .set("Cookie", cookie(owner.sid))
      .send({ agentId });
  }

  describe("POST /auth/token", () => {
    it("refuses to mint a fresh agent token for a revoked bot", async () => {
      const before = await mint(botId);
      expect(before.status, "the mint path is broken for reasons unrelated to revocation").toBe(200);
      expect(before.body.kind).toBe("agent");

      expect(await revoke(botId, "suspended for spam")).toBe(true);

      const after = await mint(botId);
      expect(after.status).toBe(403);
      expect(after.body.code).toBe("bot_revoked");
      expect(after.body.token).toBeUndefined();
    });

    it("keeps the revoked refusal distinct from the never-attached one", async () => {
      // Both are 403, and a caller that cannot tell them apart is told to go
      // and re-verify a bot that verifying will not fix.
      await revoke(botId, "suspended");
      const revoked = await mint(botId);
      const stranger = await mint(makeBotUuid());

      expect(revoked.status).toBe(403);
      expect(stranger.status).toBe(403);
      expect(revoked.body.code).toBe("bot_revoked");
      expect(stranger.body.code).toBeUndefined();
      expect(String(stranger.body.error)).toMatch(/have not proven control/i);
    });

    it("stops only the bot named, not everything the owner holds", async () => {
      await revoke(botId, "suspended");
      const other = await mint(otherBotId);
      expect(other.status, "the guard is refusing a bot nobody revoked").toBe(200);
      expect(other.body.botId).toBe(otherBotId);
    });
  });

  describe("POST /auth/token/refresh", () => {
    it("refuses to extend the lineage of a revoked bot", async () => {
      const minted = await mint(botId);
      expect(minted.status).toBe(200);
      const token = minted.body.token as string;

      const before = await request(app).post("/auth/token/refresh").send({ token });
      expect(before.status, "refresh is broken for reasons unrelated to revocation").toBe(200);
      expect(typeof before.body.token).toBe("string");

      await revoke(botId, "suspended mid-lineage");

      const after = await request(app).post("/auth/token/refresh").send({ token });
      expect(after.status).toBe(403);
      expect(after.body.code).toBe("bot_revoked");
      expect(after.body.token).toBeUndefined();
    });
  });

  describe("agentForActor", () => {
    it("refuses an owner's session acting for a revoked agent", async () => {
      const before = await actForAgent();
      expect(before.status, "the owner cannot act for their own agent at all").toBe(200);
      expect(before.body.agentId).toBe(agentId);

      await revoke(botId, "suspended for spam");

      const after = await actForAgent();
      expect(after.status).toBe(403);
      // Same wording the agent's own door uses — one fact, told one way.
      expect(String(after.body.error)).toMatch(/verification was withdrawn/i);
      expect(String(after.body.error)).toContain("suspended for spam");
      expect(after.body.agentId).toBeUndefined();
    });
  });

  describe("revoke()", () => {
    it("freezes rather than deletes, so there is something to restore", async () => {
      await revoke(botId, "temporary");
      const [row] = await db.select().from(userBotsTable).where(eq(userBotsTable.obcBotId, botId));
      expect(row, "the attachment was destroyed instead of frozen").toBeTruthy();
      expect(row!.displayName).toBe("Revocable");
      expect(row!.revokedAt).toBeInstanceOf(Date);
    });
  });

  describe("DELETE /auth/bots/:botId", () => {
    it("refuses to detach a frozen bot, so the freeze cannot be laundered off", async () => {
      // The gap the three credential gates leave open. revoked_at lives on the
      // user_bots row and nowhere else, so detaching that row erases the
      // revocation; re-attaching then INSERTs a fresh one with revoked_at NULL
      // and every gate above passes again. Performed by the owner — the party
      // the freeze was aimed at — with no admin restore() and no trace.
      const before = await request(app)
        .delete(`/auth/bots/${otherBotId}`)
        .set("Cookie", cookie(owner.sid));
      expect(before.status, "detach is broken for reasons unrelated to revocation").toBe(200);

      await revoke(botId, "suspended for spam");

      const after = await request(app).delete(`/auth/bots/${botId}`).set("Cookie", cookie(owner.sid));
      expect(after.status).toBe(403);
      expect(after.body.code).toBe("bot_revoked");

      // The row — and with it the revocation — is still there.
      const [row] = await db.select().from(userBotsTable).where(eq(userBotsTable.obcBotId, botId));
      expect(row, "the frozen attachment was detached anyway").toBeTruthy();
      expect(row!.revokedAt).toBeInstanceOf(Date);

      // And the gate the laundering was aiming at is still shut.
      expect((await mint(botId)).status).toBe(403);
    });
  });

  describe("restore()", () => {
    it("re-enables minting, refreshing and acting for the agent", async () => {
      const minted = await mint(botId);
      expect(minted.status).toBe(200);
      const token = minted.body.token as string;

      await revoke(botId, "temporary");
      expect((await mint(botId)).status).toBe(403);
      expect((await request(app).post("/auth/token/refresh").send({ token })).status).toBe(403);
      expect((await actForAgent()).status).toBe(403);

      expect(await restore(botId)).toBe(true);

      // The lineage predates the revocation and survives it: the token itself
      // was never invalidated, only the standing behind it, and lifting the
      // suspension gives that standing back.
      expect((await mint(botId)).status).toBe(200);
      expect((await request(app).post("/auth/token/refresh").send({ token })).status).toBe(200);

      const acting = await actForAgent();
      expect(acting.status).toBe(200);
      expect(acting.body.agentId, "restored the standing but lost the agent").toBe(agentId);
    });
  });
});
