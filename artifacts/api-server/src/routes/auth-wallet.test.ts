import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { ethers } from "ethers";
import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { authChallengesTable, sessionsTable, usersTable } from "@workspace/db/schema";
import authWalletRouter from "./auth-wallet";
import { cleanupAuthTestData } from "../test-helpers";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authWalletRouter);
  return app;
}

interface NonceResp {
  nonce: string;
  message: string;
  expiresAt: string;
}

async function fetchNonce(app: Express, address: string): Promise<NonceResp> {
  const res = await request(app)
    .post("/auth/wallet/nonce")
    .send({ address });
  expect(res.status).toBe(200);
  return res.body as NonceResp;
}

describe("auth-wallet (SIWE)", () => {
  let app: Express;
  const trackedAddresses: string[] = [];
  const trackedSids: string[] = [];

  beforeEach(() => {
    app = buildApp();
  });

  afterEach(async () => {
    await cleanupAuthTestData({
      addresses: trackedAddresses.splice(0),
      sids: trackedSids.splice(0),
    });
  });

  afterAll(async () => {
    await cleanupAuthTestData({ addresses: trackedAddresses, sids: trackedSids });
  });

  describe("POST /auth/wallet/nonce", () => {
    it("rejects malformed addresses", async () => {
      const res = await request(app)
        .post("/auth/wallet/nonce")
        .send({ address: "not-an-address" });
      expect(res.status).toBe(400);
    });

    it("issues a nonce + SIWE message bound to the address", async () => {
      const wallet = ethers.Wallet.createRandom();
      trackedAddresses.push(wallet.address.toLowerCase());

      const body = await fetchNonce(app, wallet.address);
      expect(body.nonce).toMatch(/^[0-9a-f]{24}$/);
      expect(body.message).toContain(wallet.address.toLowerCase());
      expect(body.message).toContain(`Nonce: ${body.nonce}`);
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const [row] = await db
        .select()
        .from(authChallengesTable)
        .where(eq(authChallengesTable.challenge, body.nonce));
      expect(row).toBeDefined();
      expect(row.kind).toBe("wallet_nonce");
      expect(row.claimSubject).toBe(wallet.address.toLowerCase());
      expect(row.consumed).toBe(false);
    });
  });

  describe("POST /auth/wallet/verify (happy path)", () => {
    it("verifies signature, upserts user, opens session", async () => {
      const wallet = ethers.Wallet.createRandom();
      trackedAddresses.push(wallet.address.toLowerCase());

      const { message, nonce } = await fetchNonce(app, wallet.address);
      const signature = await wallet.signMessage(message);

      const res = await request(app)
        .post("/auth/wallet/verify")
        .send({ address: wallet.address, signature, nonce });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.user.walletAddress).toBe(wallet.address.toLowerCase());

      // Cookie was set
      const setCookie = res.headers["set-cookie"] as unknown as string[] | undefined;
      const sidCookie = (setCookie ?? []).find((c) => c.startsWith("sid="));
      expect(sidCookie).toBeTruthy();
      const sid = sidCookie!.split(";")[0]!.split("=")[1]!;
      trackedSids.push(sid);

      // User row exists with wallet provider
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.walletAddress, wallet.address.toLowerCase()));
      expect(user).toBeDefined();
      expect(user.authProvider).toBe("wallet");

      // Session exists with `wallet:` access token
      const [sess] = await db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.sid, sid));
      expect(sess).toBeDefined();
      const data = sess.sess as { access_token?: string };
      expect(data.access_token).toBe(`wallet:${user.id}`);

      // Nonce is now consumed
      const consumed = await db
        .select()
        .from(authChallengesTable)
        .where(eq(authChallengesTable.claimSubject, wallet.address.toLowerCase()));
      expect(consumed.every((r) => r.consumed)).toBe(true);
    });

    it("re-login on the same address reuses the existing user row", async () => {
      const wallet = ethers.Wallet.createRandom();
      trackedAddresses.push(wallet.address.toLowerCase());

      // First sign-in
      const n1 = await fetchNonce(app, wallet.address);
      const sig1 = await wallet.signMessage(n1.message);
      const r1 = await request(app)
        .post("/auth/wallet/verify")
        .send({ address: wallet.address, signature: sig1, nonce: n1.nonce });
      expect(r1.status).toBe(200);
      const id1 = r1.body.user.id;

      // Second sign-in
      const n2 = await fetchNonce(app, wallet.address);
      const sig2 = await wallet.signMessage(n2.message);
      const r2 = await request(app)
        .post("/auth/wallet/verify")
        .send({ address: wallet.address, signature: sig2, nonce: n2.nonce });
      expect(r2.status).toBe(200);
      expect(r2.body.user.id).toBe(id1);

      // Track all created sids for cleanup
      for (const r of [r1, r2]) {
        const sc = (r.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
        const c = sc.find((x) => x.startsWith("sid="));
        if (c) trackedSids.push(c.split(";")[0]!.split("=")[1]!);
      }
    });
  });

  describe("POST /auth/wallet/verify (rejection paths)", () => {
    it("rejects wrong-address signature", async () => {
      const userWallet = ethers.Wallet.createRandom();
      const attacker = ethers.Wallet.createRandom();
      trackedAddresses.push(userWallet.address.toLowerCase(), attacker.address.toLowerCase());

      const { message, nonce } = await fetchNonce(app, userWallet.address);
      // Attacker signs the message issued for userWallet
      const badSig = await attacker.signMessage(message);
      const res = await request(app)
        .post("/auth/wallet/verify")
        .send({ address: userWallet.address, signature: badSig, nonce });
      expect(res.status).toBe(401);
    });

    // (Replaces the old "rejects malformed messages" test — the API no
    // longer accepts a client-supplied message, so the only shape that
    // can fail this way is a malformed nonce string.)
    it("rejects malformed nonce", async () => {
      const wallet = ethers.Wallet.createRandom();
      trackedAddresses.push(wallet.address.toLowerCase());
      const sig = await wallet.signMessage("anything");
      const res = await request(app)
        .post("/auth/wallet/verify")
        .send({ address: wallet.address, signature: sig, nonce: "not-hex!!!" });
      expect(res.status).toBe(400);
    });

    // Phishing-via-tampered-message regression: even if an attacker
    // gets a victim to sign an arbitrary message containing a real
    // nonce, /verify must reject because the canonical message text
    // is stored server-side and the signature won't recover the
    // claimed address against it.
    it("rejects signature over a tampered message", async () => {
      const wallet = ethers.Wallet.createRandom();
      trackedAddresses.push(wallet.address.toLowerCase());
      const { nonce } = await fetchNonce(app, wallet.address);
      // Wallet signs a DIFFERENT message that still contains the nonce.
      const phishedMessage = `EVIL.com would love your signature here.\n\nNonce: ${nonce}\n`;
      const sig = await wallet.signMessage(phishedMessage);
      const res = await request(app)
        .post("/auth/wallet/verify")
        .send({ address: wallet.address, signature: sig, nonce });
      expect(res.status).toBe(401);
    });

    it("rejects expired nonce", async () => {
      const wallet = ethers.Wallet.createRandom();
      trackedAddresses.push(wallet.address.toLowerCase());

      const { message, nonce } = await fetchNonce(app, wallet.address);
      // Force-expire the nonce in the DB
      await db
        .update(authChallengesTable)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(authChallengesTable.challenge, nonce));

      const sig = await wallet.signMessage(message);
      const res = await request(app)
        .post("/auth/wallet/verify")
        .send({ address: wallet.address, signature: sig, nonce });
      expect(res.status).toBe(401);
    });

    it("rejects replay (same nonce signed twice)", async () => {
      const wallet = ethers.Wallet.createRandom();
      trackedAddresses.push(wallet.address.toLowerCase());

      const { message, nonce } = await fetchNonce(app, wallet.address);
      const sig = await wallet.signMessage(message);

      const r1 = await request(app)
        .post("/auth/wallet/verify")
        .send({ address: wallet.address, signature: sig, nonce });
      expect(r1.status).toBe(200);
      const sc = (r1.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
      const c = sc.find((x) => x.startsWith("sid="));
      if (c) trackedSids.push(c.split(";")[0]!.split("=")[1]!);

      // Second attempt with the exact same payload must fail.
      const r2 = await request(app)
        .post("/auth/wallet/verify")
        .send({ address: wallet.address, signature: sig, nonce });
      expect(r2.status).toBe(401);
    });

    it("rejects address-mismatch (nonce was issued for a different address)", async () => {
      const userA = ethers.Wallet.createRandom();
      const userB = ethers.Wallet.createRandom();
      trackedAddresses.push(userA.address.toLowerCase(), userB.address.toLowerCase());

      // Issue nonce for B; A tries to redeem the same SIWE message.
      const { message, nonce } = await fetchNonce(app, userB.address);
      const sigA = await userA.signMessage(message);
      const res = await request(app)
        .post("/auth/wallet/verify")
        .send({ address: userA.address, signature: sigA, nonce });
      expect(res.status).toBe(401);
    });
  });

  it("disabled accounts cannot sign in", async () => {
    const wallet = ethers.Wallet.createRandom();
    trackedAddresses.push(wallet.address.toLowerCase());
    // Pre-create the user as disabled.
    await db.insert(usersTable).values({
      walletAddress: wallet.address.toLowerCase(),
      authProvider: "wallet",
      displayName: "disabled",
      disabledAt: new Date(),
    });
    const { message, nonce } = await fetchNonce(app, wallet.address);
    const sig = await wallet.signMessage(message);
    const res = await request(app)
      .post("/auth/wallet/verify")
      .send({ address: wallet.address, signature: sig, nonce });
    expect(res.status).toBe(403);
  });
});
