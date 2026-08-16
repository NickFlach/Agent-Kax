/**
 * ledger-my.test.ts — the wallet a principal reads about itself.
 *
 * `credits` is a published float and stays one, so it cannot be corrected
 * without breaking whoever already parses it. `creditsExact` is the honest
 * number beside it, and it only earns its place above 2^53 minor units — the
 * magnitude at which the float stops being able to represent the balance the
 * ledger is holding. That is exactly the case no test of the route existed
 * for: `creditsExact` could have been deleted, renamed, or quietly re-wired to
 * the lossy division and nothing in the suite would have noticed.
 *
 * So this funds a balance past that boundary and asserts the two fields
 * DISAGREE. A collapse back onto the float makes them equal, which is the one
 * thing this file will not let pass.
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
import { HOUSE_ACCOUNT, MINOR_UNITS_PER_CREDIT } from "../lib/ledger-core";
import { _resetKeyCache } from "../lib/identity";
import { cleanupAuthTestData, createWalletUser, makeBotUuid, makeTestId } from "../test-helpers";

const ASSET = "play_credit";

/** 2^53 + 1 minor units: the first balance a float cannot carry. */
const BEYOND_FLOAT = 9_007_199_254_740_993n;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(identityRouter);
  app.use(ledgerRouter);
  return app;
}

describe("GET /ledger/my", () => {
  const app = makeApp();
  const trackedAddresses: string[] = [];
  const trackedUserIds: string[] = [];
  const trackedSids: string[] = [];

  let owner: { id: string; address: string; sid: string };
  let botId: string;
  let priorJwk: string | undefined;

  beforeAll(async () => {
    // With no signing key the mint 503s and every assertion below would pass
    // for the wrong reason.
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

    // A fresh bot per test, because the ledger is append-only and has no
    // cleanup: reusing an account would carry the previous run's balance in.
    botId = makeBotUuid();
    await db.insert(userBotsTable).values({ userId: owner.id, obcBotId: botId, displayName: "Rich" });
  });

  /**
   * The agent identity token this bot's owner may mint for it. Minting also
   * lands the signup grant on the same trader account, so nothing here may
   * assume the wallet opens at zero.
   */
  async function agentToken(): Promise<string> {
    const minted = await request(app)
      .post("/auth/token")
      .set("Cookie", `sid=${owner.sid}`)
      .send({ obcBotId: botId });
    expect(minted.status, "the mint path is broken for reasons unrelated to this test").toBe(200);
    return minted.body.token as string;
  }

  function wallet(token: string) {
    return request(app).get("/ledger/my").set("Authorization", `Bearer ${token}`);
  }

  /** Top the agent's trader account up to exactly `target` minor units. */
  async function fundTo(token: string, target: bigint): Promise<void> {
    const opening = await wallet(token);
    expect(opening.status).toBe(200);
    const topUp = target - BigInt(String(opening.body.balance));
    expect(topUp, "the signup grant already exceeds the target balance").toBeGreaterThan(0n);
    await postTransaction({
      txId: makeTestId("ledger-my-fund"),
      asset: ASSET,
      postings: [
        { account: HOUSE_ACCOUNT, amount: -topUp, kind: "grant", ref: "ledger-my test" },
        { account: `trader:kax:agent:${botId}`, amount: topUp, kind: "grant", ref: "ledger-my test" },
      ],
    });
  }

  it("reports a balance the float cannot hold, exactly, and says so twice over", async () => {
    const token = await agentToken();
    await fundTo(token, BEYOND_FLOAT);

    const r = await wallet(token);
    expect(r.status).toBe(200);
    expect(r.body.principal).toBe(`kax:agent:${botId}`);
    // The raw minor units are the ground truth the other two fields render.
    expect(r.body.balance).toBe(BEYOND_FLOAT.toString());
    expect(r.body.creditsExact).toBe("9007199254.740993");

    // The load-bearing assertion. `credits` is the lossy float the API has
    // always published; if `creditsExact` is ever collapsed back onto it these
    // two become equal, and that is the regression this file exists to catch.
    expect(String(r.body.credits)).not.toBe(r.body.creditsExact);
    expect(r.body.credits).toBe(Number(BEYOND_FLOAT) / Number(MINOR_UNITS_PER_CREDIT));

    // Reassembling the digits recovers the balance byte for byte, which no
    // float-derived string could survive.
    expect(BigInt(String(r.body.creditsExact).replace(".", ""))).toBe(BEYOND_FLOAT);
  });

  it("renders an ordinary whole-credit balance without inventing a fractional part", async () => {
    // So the exact renderer is not exercised only at the one magnitude where
    // it differs from the float — a `creditsExact` that is right about 2^53
    // and wrong about 250 would still be wrong.
    const token = await agentToken();
    await fundTo(token, MINOR_UNITS_PER_CREDIT * 250n);

    const r = await wallet(token);
    expect(r.status).toBe(200);
    expect(r.body.creditsExact).toBe("250");
    expect(r.body.credits).toBe(250);
  });

  it("refuses to report a balance to a caller with no identity token", async () => {
    // Otherwise the endpoint answers whoever asked, and it answers with money.
    expect((await request(app).get("/ledger/my")).status).toBe(401);
    expect((await request(app).get("/ledger/my").set("Authorization", "Bearer nonsense")).status).toBe(401);
  });
});
