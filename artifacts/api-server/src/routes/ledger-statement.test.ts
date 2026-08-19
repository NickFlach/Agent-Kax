/**
 * ledger-statement.test.ts — #250's acceptance criteria for
 * GET /ledger/my/statement.
 *
 * Harness mirrors ledger-my.test.ts: a real express app, a real wallet user,
 * a real minted agent token. The properties that matter here:
 *
 *  - the account is derived from the TOKEN — no parameter names an account;
 *  - bearer-only auth, a session cookie is 401 (the bearer-means-two-things
 *    trap documented across lib/auth.ts and lib/actor.ts);
 *  - keyset pagination stays stable across a concurrent append;
 *  - runningBalance on the newest entry agrees with /ledger/my.
 *
 * DB-backed; runs in CI.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { generateKeyPair, exportJWK } from "jose";
import { db } from "@workspace/db";
import { userBotsTable } from "@workspace/db/schema";
import identityRouter from "./identity";
import ledgerRouter from "./ledger";
import { authMiddleware } from "../middlewares/authMiddleware";
import { postTransaction } from "../lib/ledger";
import { HOUSE_ACCOUNT } from "../lib/ledger-core";
import { _resetKeyCache } from "../lib/identity";
import { cleanupAuthTestData, createWalletUser, makeBotUuid } from "../test-helpers";

const ASSET = "play_credit";
const uniq = () => Math.random().toString(36).slice(2, 10);

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(identityRouter);
  app.use(ledgerRouter);
  return app;
}

describe("GET /ledger/my/statement", () => {
  const app = makeApp();
  const trackedAddresses: string[] = [];
  const trackedUserIds: string[] = [];
  const trackedSids: string[] = [];

  let owner: { id: string; address: string; sid: string };
  let botId: string;
  let priorJwk: string | undefined;

  beforeAll(async () => {
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
      addresses: trackedAddresses.splice(0),
      userIds: trackedUserIds.splice(0),
      sids: trackedSids.splice(0),
    });
  });

  beforeEach(async () => {
    owner = await createWalletUser();
    trackedUserIds.push(owner.id);
    trackedAddresses.push(owner.address);
    trackedSids.push(owner.sid);
    botId = makeBotUuid();
    await db.insert(userBotsTable).values({ userId: owner.id, obcBotId: botId, displayName: "Reader" });
  });

  async function agentToken(): Promise<string> {
    const minted = await request(app)
      .post("/auth/token")
      .set("Cookie", `sid=${owner.sid}`)
      .send({ obcBotId: botId });
    expect(minted.status, "the mint path is broken for reasons unrelated to this test").toBe(200);
    return minted.body.token as string;
  }

  function principalAccount(): string {
    return `trader:kax:agent:${botId}`;
  }

  async function grant(amount: bigint): Promise<void> {
    await postTransaction({
      actor: "test:suite",
      txId: `stmt-${uniq()}`,
      asset: ASSET,
      postings: [
        { account: HOUSE_ACCOUNT, amount: -amount, kind: "grant" },
        { account: principalAccount(), amount, kind: "grant" },
      ],
    });
  }

  it("requires a bearer token: no header is 401, a session cookie is 401", async () => {
    const bare = await request(app).get("/ledger/my/statement");
    expect(bare.status).toBe(401);
    const cookie = await request(app)
      .get("/ledger/my/statement")
      .set("Cookie", `sid=${owner.sid}`);
    expect(cookie.status).toBe(401);
  });

  it("derives the account from the token and agrees with /ledger/my", async () => {
    const token = await agentToken(); // minting lands the signup grant too
    await grant(120n);
    await grant(35n);

    const my = await request(app).get("/ledger/my").set("Authorization", `Bearer ${token}`);
    const stmt = await request(app)
      .get("/ledger/my/statement")
      .set("Authorization", `Bearer ${token}`);
    expect(stmt.status).toBe(200);
    expect(stmt.body.principal).toBe(`kax:agent:${botId}`);
    expect(stmt.body.entries.length).toBeGreaterThanOrEqual(3); // signup grant + two grants
    // Newest-first, and the newest entry's running balance IS the wallet.
    const seqs = stmt.body.entries.map((e: { seq: number }) => e.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
    expect(stmt.body.entries[0].runningBalance).toBe(my.body.balance);
    // Amounts are strings — never floats.
    for (const e of stmt.body.entries) expect(typeof e.amount).toBe("string");
  });

  it("has no parameter that can name another account", async () => {
    const token = await agentToken();
    // A hostile caller tries every plausible spelling; the response must be
    // the caller's own postings regardless (the parameters are simply not
    // part of the contract — nothing reads them).
    const stmt = await request(app)
      .get("/ledger/my/statement")
      .query({ account: "house", principal: "kax:user:somebody-else" })
      .set("Authorization", `Bearer ${token}`);
    expect(stmt.status).toBe(200);
    expect(stmt.body.principal).toBe(`kax:agent:${botId}`);
    for (const e of stmt.body.entries) {
      // Every entry is a posting on the caller's own account: the signup
      // grant plus anything this suite granted — all `grant` rows unless the
      // caller spent, and this one never did.
      expect(e.kind).toBe("grant");
    }
  });

  it("keyset pagination is stable across an append: no duplicates, no skips", async () => {
    const token = await agentToken();
    for (let i = 0; i < 5; i++) await grant(BigInt(10 + i));

    const page1 = await request(app)
      .get("/ledger/my/statement")
      .query({ limit: "3" })
      .set("Authorization", `Bearer ${token}`);
    expect(page1.body.entries).toHaveLength(3);
    expect(page1.body.nextBefore).toBe(page1.body.entries[2].seq);

    // An append lands MID-PAGINATION. New postings take higher seqs, so the
    // cursor anchored below page 1 must see neither it nor any duplicate.
    await grant(999n);

    const page2 = await request(app)
      .get("/ledger/my/statement")
      .query({ limit: "100", before: String(page1.body.nextBefore) })
      .set("Authorization", `Bearer ${token}`);
    const seen1 = new Set(page1.body.entries.map((e: { seq: number }) => e.seq));
    for (const e of page2.body.entries) {
      expect(seen1.has(e.seq), `seq ${e.seq} appeared on both pages`).toBe(false);
      expect(e.seq).toBeLessThan(page1.body.nextBefore);
      expect(e.amount).not.toBe("999"); // the mid-pagination append is invisible
    }
    // No skips: pages 1+2 together are exactly the account's rows below the
    // newest three... which is everything minted before the append.
    const my = await request(app).get("/ledger/my").set("Authorization", `Bearer ${token}`);
    const all = await request(app)
      .get("/ledger/my/statement")
      .query({ limit: "100" })
      .set("Authorization", `Bearer ${token}`);
    expect(all.body.entries[0].runningBalance).toBe(my.body.balance);
    expect(all.body.entries.length).toBe(page1.body.entries.length + page2.body.entries.length + 1);
  });
});
