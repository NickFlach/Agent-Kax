/**
 * auth-user-wallet-metadata.test.ts — wallet metadata must survive the page
 * reload, not just the sign-in response (#27).
 *
 * `/auth/wallet/verify` returned `walletAddress`, but `/auth/user` — the
 * endpoint the client hits on every subsequent load — rebuilt the auth user
 * without it. So the wallet address was present for exactly one response and
 * `undefined` from then on.
 *
 * The cause is what makes this worth a test rather than a comment: the fields
 * were always in the OpenAPI schema, and `GetCurrentAuthUserResponse.parse()`
 * silently STRIPPED them because the handler never supplied them. No error, no
 * warning — the contract said they existed and the response simply did not have
 * them.
 *
 * `/auth/user` had no test at all, so the fix is currently unguarded against
 * exactly the same silent-strip regression. This covers the persistent path;
 * `auth-wallet.test.ts` already covers the verify response.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { ethers } from "ethers";
import authWalletRouter from "./auth-wallet";
import authRouter from "./auth";
import { authMiddleware } from "../middlewares/authMiddleware";
import { cleanupAuthTestData } from "../test-helpers";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // The real chain: authMiddleware resolves the session cookie and stamps
  // req.authProvider, which is where `provider` in the response comes from.
  app.use(authMiddleware);
  app.use(authWalletRouter);
  app.use(authRouter);
  return app;
}

/** Sign in with a fresh wallet, returning its address and session cookie. */
async function walletSignIn(app: Express): Promise<{ address: string; cookie: string }> {
  const wallet = ethers.Wallet.createRandom();
  const nonceRes = await request(app)
    .post("/auth/wallet/nonce")
    .send({ address: wallet.address });
  expect(nonceRes.status).toBe(200);

  const signature = await wallet.signMessage(nonceRes.body.message);
  const verifyRes = await request(app)
    .post("/auth/wallet/verify")
    .send({ address: wallet.address, signature, nonce: nonceRes.body.nonce });
  expect(verifyRes.status).toBe(200);

  const setCookie = verifyRes.headers["set-cookie"] as unknown as string[] | undefined;
  const sid = (setCookie ?? []).find((c) => c.startsWith("sid="));
  expect(sid, "wallet verify must set a session cookie").toBeTruthy();
  return { address: wallet.address.toLowerCase(), cookie: sid!.split(";")[0]! };
}

describe("GET /auth/user preserves wallet metadata (#27)", () => {
  let app: Express;
  const addresses: string[] = [];

  beforeEach(() => {
    app = buildApp();
  });

  afterEach(async () => {
    await cleanupAuthTestData({ addresses: addresses.splice(0) });
  });

  afterAll(async () => {
    await cleanupAuthTestData({ addresses });
  });

  it("returns walletAddress on the persistent path, not only at sign-in", async () => {
    const { address, cookie } = await walletSignIn(app);
    addresses.push(address);

    const res = await request(app).get("/auth/user").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.user, "a signed-in wallet session must resolve a user").toBeTruthy();
    // The actual bug: present at verify, undefined forever after.
    expect(res.body.user.walletAddress).toBe(address);
  });

  it("reports the auth provider so the client can tell how it signed in", async () => {
    const { address, cookie } = await walletSignIn(app);
    addresses.push(address);

    const res = await request(app).get("/auth/user").set("Cookie", cookie);
    expect(res.body.user.provider).toBe("wallet");
  });

  it("survives the response schema — the field is not silently stripped", async () => {
    // This is the regression that actually happened: the fields were in the
    // OpenAPI schema all along, and `GetCurrentAuthUserResponse.parse()` dropped
    // them because the handler never supplied them. Asserting the KEY exists
    // catches a re-strip, which an undefined-vs-missing check would not.
    const { address, cookie } = await walletSignIn(app);
    addresses.push(address);

    const res = await request(app).get("/auth/user").set("Cookie", cookie);
    expect(Object.keys(res.body.user)).toContain("walletAddress");
    expect(Object.keys(res.body.user)).toContain("provider");
  });

  it("still reports null for an unauthenticated caller", async () => {
    // The over-correction guard: leaking a user for a cookie-less request would
    // also make the assertions above pass.
    const res = await request(app).get("/auth/user");
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});
