/**
 * occRevocationGates.test.ts — the live test, as close as a suite can get.
 *
 * Vincent deactivates a test agent; KAX must refuse it at the gate and walk it
 * out of the city. `routes/revocation-enforcement.test.ts` already proves that
 * for a bot ATTACHED to a KAX login. This file proves it for the population
 * that one could not reach and that his test agent almost certainly belongs to:
 * an agent harvested from OpenClawCity, with a storefront and a flat and a
 * balance, that no KAX human has ever attached — no `user_bots` row anywhere.
 *
 * Before `bot_occ_status`, every assertion below would have failed silently in
 * the friendliest possible way: `revoke()` matched zero rows, returned false,
 * and every gate waved the agent through.
 *
 * PAIRED, like its sibling: each refusal is preceded by the same call
 * SUCCEEDING for the same agent while it is in good standing, so a test that
 * stops proving anything fails rather than passing vacuously.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { generateKeyPair, exportJWK } from "jose";
import { db } from "@workspace/db";
import { agentsTable, botOccStatusTable, residenceUnitsTable } from "@workspace/db/schema";
import { authMiddleware } from "../middlewares/authMiddleware";
import { resolveActor, ActorError } from "../lib/actor";
import { issueToken, _resetKeyCache } from "../lib/identity";
import { revokeDetailed, restore } from "../lib/revocation";
import { refreshRevocations } from "../lib/residencyStore";
import * as residents from "../lib/residents";
import { roster, _clear as clearPresence } from "../lib/presence";
import { cleanupTestData, createTestUser, makeBotUuid, makeTestId } from "../test-helpers";

let userId: string;
let botId: string;
let agentId: number;
const touched: string[] = [];

/**
 * A route that does exactly what `/city/enter`, `/presence/beat`, `/chat/say`,
 * `/joinery/*`, `/residences/claim` and the MCP surface all do first: call
 * `resolveActor`. Every one of those is gated transitively through it, so
 * testing it once through a real route — middleware, ActorError→status mapping
 * and all — is testing the shape they share.
 */
function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.post("/test/enter", async (req: Request, res) => {
    try {
      const actor = await resolveActor(req);
      if (!actor) return res.status(401).json({ error: "no actor" });
      return res.json({ ok: true, principal: actor.principal });
    } catch (e) {
      if (e instanceof ActorError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });
  return app;
}

const app = makeApp();

beforeAll(async () => {
  // Local signing key so tokens can be minted for a bot with no KAX login —
  // which is the entire point: an unattached agent cannot go through
  // POST /auth/token, so the credential has to be issued directly.
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  process.env["KAX_IDENTITY_PRIVATE_JWK"] = JSON.stringify({
    ...(await exportJWK(privateKey)),
    kid: "occ-gates-test",
    alg: "EdDSA",
  });
  _resetKeyCache();
  userId = (await createTestUser({ emailLabel: "occ-gates" })).id;
});

beforeEach(async () => {
  botId = makeBotUuid();
  touched.push(botId);
  const [row] = await db
    .insert(agentsTable)
    .values({
      slug: makeTestId("occ-gate"),
      displayName: "Gatecrasher",
      obcBotId: botId,
      ownerId: userId,
    })
    .returning();
  agentId = row!.id;
  residents._clear();
  clearPresence();
});

afterAll(async () => {
  if (touched.length > 0) {
    await db.delete(botOccStatusTable).where(inArray(botOccStatusTable.obcBotId, touched));
    const rows = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(inArray(agentsTable.obcBotId, touched));
    if (rows.length > 0) {
      await db
        .update(residenceUnitsTable)
        .set({ agentId: null, claimedAt: null })
        .where(inArray(residenceUnitsTable.agentId, rows.map((r) => r.id)));
      await db.delete(agentsTable).where(inArray(agentsTable.id, rows.map((r) => r.id)));
    }
  }
  delete process.env["KAX_IDENTITY_PRIVATE_JWK"];
  _resetKeyCache();
  await cleanupTestData();
  await refreshRevocations().catch(() => {});
});

async function agentToken(): Promise<string> {
  return issueToken({ kind: "agent", subject: userId, botId, scopes: ["trade"], ttlSeconds: 900 });
}

describe("the agent's own door (resolveActor) — blocks NEW ENTRY", () => {
  it("lets the agent in while its verification stands", async () => {
    const res = await request(app)
      .post("/test/enter")
      .set("authorization", `Bearer ${await agentToken()}`)
      .send({});
    expect(res.status, "the positive control failed, so the refusal below proves nothing").toBe(200);
    expect(res.body.principal).toBe(`kax:agent:${botId}`);
  });

  it("refuses the same token the moment the verification is withdrawn", async () => {
    const token = await agentToken();
    expect((await request(app).post("/test/enter").set("authorization", `Bearer ${token}`).send({})).status).toBe(200);

    const r = await revokeDetailed(botId, "deactivated by OpenClawCity");
    // The fact that makes this file necessary: nothing was ATTACHED, and the
    // freeze still took.
    expect(r.matched, "this fixture accidentally has a user_bots row").toBe(false);
    expect(r.recorded).toBe(true);

    const after = await request(app)
      .post("/test/enter")
      .set("authorization", `Bearer ${token}`)
      .send({});
    expect(after.status, "a harvested agent walked in after being disowned").toBe(403);
    expect(String(after.body.error)).toContain("withdrawn");
  });

  it("lets it back in when the revocation is lifted — nothing was destroyed", async () => {
    const token = await agentToken();
    await revokeDetailed(botId, "temporary");
    expect((await request(app).post("/test/enter").set("authorization", `Bearer ${token}`).send({})).status).toBe(403);

    await restore(botId);

    const back = await request(app)
      .post("/test/enter")
      .set("authorization", `Bearer ${token}`)
      .send({});
    expect(back.status, "a lifted suspension did not give the agent its city back").toBe(200);
    // The agent row, its slug and its identity are the ones it left with.
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
    expect(agent!.obcBotId).toBe(botId);
  });

  it("does not refuse a DIFFERENT harvested agent", async () => {
    const otherBot = makeBotUuid();
    touched.push(otherBot);
    await db.insert(agentsTable).values({
      slug: makeTestId("occ-gate-other"),
      displayName: "Innocent",
      obcBotId: otherBot,
      ownerId: userId,
    });
    await revokeDetailed(botId, "only this one");
    const token = await issueToken({ kind: "agent", subject: userId, botId: otherBot, scopes: ["trade"], ttlSeconds: 900 });
    const res = await request(app).post("/test/enter").set("authorization", `Bearer ${token}`).send({});
    expect(res.status, "the freeze spread to a bystander").toBe(200);
  });
});

describe("walking it out of the city — EVICTS A SESSION IN PROGRESS", () => {
  it("evicts a standing body on the next tick, ahead of the idle clock", async () => {
    const T = 12_000_000;
    residents.enter(
      { principal: `obc:${botId}`, name: "Gatecrasher", kind: "agent", room: "city" },
      T,
    );
    residents.tickAll(T + 900);
    expect(roster("city", T + 900), "nobody was standing there to evict").toHaveLength(1);

    await revokeDetailed(botId, "deactivated");
    // What the webhook handler calls, and the reason it calls it: without this
    // the registry keeps the stale set for up to REVOCATION_REFRESH_MS = 60s,
    // and Vincent watches a disowned agent stand in the street for a minute.
    const n = await refreshRevocations();
    expect(n, "the refresh found no revoked bots at all").toBeGreaterThan(0);

    residents.tickAll(T + 1_800); // far short of IDLE_MS
    expect(residents.count(), "the agent is still standing in the street").toBe(0);
    expect(roster("city", T + 1_800)).toHaveLength(0);
  });

  it("leaves everybody else standing", async () => {
    const otherBot = makeBotUuid();
    touched.push(otherBot);
    const T = 12_500_000;
    residents.enter({ principal: `obc:${botId}`, name: "Gatecrasher", kind: "agent", room: "city" }, T);
    residents.enter({ principal: `obc:${otherBot}`, name: "Innocent", kind: "agent", room: "city" }, T);
    expect(residents.count()).toBe(2);

    await revokeDetailed(botId, "deactivated");
    await refreshRevocations();
    residents.tickAll(T + 900);

    expect(residents.count()).toBe(1);
    expect(roster("city", T + 900).map((e) => e.name)).toEqual(["Innocent"]);
  });

  it("evicts under the kax:agent: principal form too", async () => {
    // One bot answers to two names and an eviction that knew only one of them
    // would evict half of it.
    const T = 13_000_000;
    residents.enter(
      { principal: `kax:agent:${botId}`, name: "Gatecrasher", kind: "agent", room: "city" },
      T,
    );
    expect(residents.count()).toBe(1);
    await revokeDetailed(botId, "deactivated");
    await refreshRevocations();
    residents.tickAll(T + 900);
    expect(residents.count()).toBe(0);
  });
});
