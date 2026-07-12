import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { ethers } from "ethers";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import authEmailRouter, { registerLimiter, loginLimiter } from "./auth-email";
import authWalletRouter from "./auth-wallet";
import { authMiddleware } from "../middlewares/authMiddleware";
import { SESSION_COOKIE } from "../lib/auth";
import { cleanupAuthTestData, createWalletUser, makeTestId } from "../test-helpers";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(authWalletRouter); // for /auth/wallet/nonce in link tests
  app.use(authEmailRouter);
  // Test hook: expose whatever express computes as req.ip so limiter
  // keys can be cleared exactly (no guessing at IPv4/IPv6 mapping).
  app.get("/__test/ip", (req, res) => {
    res.json({ ip: req.ip ?? "unknown" });
  });
  return app;
}

async function ipKey(app: Express): Promise<string> {
  const res = await request(app).get("/__test/ip");
  return `ip:${(res.body as { ip: string }).ip}`;
}

function makeEmail(label = "email"): string {
  return `${makeTestId(label)}@example.test`;
}

/** Pull the kax session cookie pair out of a Set-Cookie header. */
function sessionCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const hit = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  expect(hit, "expected a session cookie").toBeTruthy();
  return hit!.split(";")[0]!;
}

const PASSWORD = "correct-horse-battery";

describe("auth-email", () => {
  let app: Express;
  const trackedEmails: string[] = [];
  const trackedUserIds: string[] = [];
  const trackedAddresses: string[] = [];
  const trackedSids: string[] = [];

  beforeEach(() => {
    app = buildApp();
    registerLimiter.reset();
    loginLimiter.reset();
  });

  afterEach(async () => {
    await cleanupAuthTestData({
      emails: trackedEmails.splice(0),
      userIds: trackedUserIds.splice(0),
      addresses: trackedAddresses.splice(0),
      sids: trackedSids.splice(0),
    });
    registerLimiter.reset();
    loginLimiter.reset();
  });

  async function registerUser(email = makeEmail(), password = PASSWORD) {
    trackedEmails.push(email);
    const res = await request(app)
      .post("/auth/email/register")
      .send({ email, password });
    return { res, email, password };
  }

  describe("POST /auth/email/register", () => {
    it("creates an account, opens a session, and reports the email provider", async () => {
      const { res, email } = await registerUser();
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.provider).toBe("email");
      expect(res.body.user.hasPassword).toBe(true);
      expect(res.body.user.displayName).toBe(email.split("@")[0]);
      const cookie = sessionCookie(res);
      trackedSids.push(decodeURIComponent(cookie.split("=")[1] ?? ""));

      // the session actually authenticates
      const linkRes = await request(app)
        .post("/auth/link/email")
        .set("Cookie", cookie)
        .send({ email, password: PASSWORD });
      expect(linkRes.status).toBe(409); // password already set — proves req.user resolved
    });

    it("lowercases the email and rejects duplicates with 409", async () => {
      const email = makeEmail("dup");
      const { res } = await registerUser(email);
      expect(res.status).toBe(200);

      const dupRes = await request(app)
        .post("/auth/email/register")
        .send({ email: email.toUpperCase(), password: PASSWORD });
      expect(dupRes.status).toBe(409);
    });

    it("rejects invalid bodies", async () => {
      const bad = [
        { email: "not-an-email", password: PASSWORD },
        { email: makeEmail(), password: "short" },
        {},
      ];
      for (const body of bad) {
        const res = await request(app).post("/auth/email/register").send(body);
        expect(res.status).toBe(400);
      }
    });

    it("rate-limits registration per IP after 5 attempts", async () => {
      for (let i = 0; i < 5; i++) {
        await registerUser();
      }
      const email = makeEmail("limited");
      trackedEmails.push(email);
      const res = await request(app)
        .post("/auth/email/register")
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(429);
    });
  });

  describe("POST /auth/email/login", () => {
    it("signs in with correct credentials", async () => {
      const { email } = await registerUser();
      const res = await request(app)
        .post("/auth/email/login")
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.hasPassword).toBe(true);
      const cookie = sessionCookie(res);
      trackedSids.push(decodeURIComponent(cookie.split("=")[1] ?? ""));
    });

    it("returns the same generic 401 for unknown email and wrong password", async () => {
      const { email } = await registerUser();
      const unknown = await request(app)
        .post("/auth/email/login")
        .send({ email: makeEmail("ghost"), password: PASSWORD });
      const wrongPw = await request(app)
        .post("/auth/email/login")
        .send({ email, password: "definitely-wrong" });
      expect(unknown.status).toBe(401);
      expect(wrongPw.status).toBe(401);
      expect(unknown.body.error).toBe(wrongPw.body.error);
    });

    it("rejects wallet-only accounts (no password set) with the generic 401", async () => {
      const wallet = await createWalletUser();
      trackedUserIds.push(wallet.id);
      trackedSids.push(wallet.sid);
      // Give the wallet user an email but no password
      const email = makeEmail("walletonly");
      trackedEmails.push(email);
      await db.update(usersTable).set({ email }).where(eq(usersTable.id, wallet.id));

      const res = await request(app)
        .post("/auth/email/login")
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("invalid email or password");
    });

    it("rate-limits per email and forgives the window on success", async () => {
      const { email } = await registerUser();
      const key = await ipKey(app);
      // 9 failures (these stay under the 10-hit email window)
      for (let i = 0; i < 9; i++) {
        const res = await request(app)
          .post("/auth/email/login")
          .send({ email, password: "wrong-password" });
        expect(res.status).toBe(401);
      }
      loginLimiter.clear(key);
      // 10th hit on the email key succeeds with the right password → window cleared
      const okRes = await request(app)
        .post("/auth/email/login")
        .send({ email, password: PASSWORD });
      expect(okRes.status).toBe(200);
      const cookie = sessionCookie(okRes);
      trackedSids.push(decodeURIComponent(cookie.split("=")[1] ?? ""));

      // and the user can immediately try again without a 429
      loginLimiter.clear(key);
      const again = await request(app)
        .post("/auth/email/login")
        .send({ email, password: "wrong-password" });
      expect(again.status).toBe(401); // not 429 — email window was forgiven
    });

    it("returns 429 once the email window is exhausted", async () => {
      const { email } = await registerUser();
      const key = await ipKey(app);
      for (let i = 0; i < 10; i++) {
        loginLimiter.clear(key);
        await request(app)
          .post("/auth/email/login")
          .send({ email, password: "wrong-password" });
      }
      loginLimiter.clear(key);
      const res = await request(app)
        .post("/auth/email/login")
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(429);
    });
  });

  describe("POST /auth/link/email", () => {
    it("requires authentication", async () => {
      const res = await request(app)
        .post("/auth/link/email")
        .send({ email: makeEmail(), password: PASSWORD });
      expect(res.status).toBe(401);
    });

    it("lets a wallet-first user add the email door, then sign in with it", async () => {
      const wallet = await createWalletUser();
      trackedUserIds.push(wallet.id);
      trackedSids.push(wallet.sid);
      const email = makeEmail("link");
      trackedEmails.push(email);

      const linkRes = await request(app)
        .post("/auth/link/email")
        .set("Cookie", `${SESSION_COOKIE}=${wallet.sid}`)
        .send({ email, password: PASSWORD });
      expect(linkRes.status).toBe(200);
      expect(linkRes.body).toMatchObject({
        email,
        walletAddress: wallet.address,
        hasPassword: true,
      });

      const loginRes = await request(app)
        .post("/auth/email/login")
        .send({ email, password: PASSWORD });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.id).toBe(wallet.id); // same users row — one account
      expect(loginRes.body.user.walletAddress).toBe(wallet.address);
      const cookie = sessionCookie(loginRes);
      trackedSids.push(decodeURIComponent(cookie.split("=")[1] ?? ""));
    });

    it("409s when the email belongs to another account", async () => {
      const { email } = await registerUser();
      const wallet = await createWalletUser();
      trackedUserIds.push(wallet.id);
      trackedSids.push(wallet.sid);

      const res = await request(app)
        .post("/auth/link/email")
        .set("Cookie", `${SESSION_COOKIE}=${wallet.sid}`)
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(409);
    });

    it("409s when a password is already set", async () => {
      const { res: regRes, email } = await registerUser();
      const cookie = sessionCookie(regRes);
      trackedSids.push(decodeURIComponent(cookie.split("=")[1] ?? ""));
      const res = await request(app)
        .post("/auth/link/email")
        .set("Cookie", cookie)
        .send({ email, password: "another-password" });
      expect(res.status).toBe(409);
    });
  });

  describe("POST /auth/link/wallet", () => {
    async function walletProof(wallet: ethers.Wallet) {
      const nonceRes = await request(app)
        .post("/auth/wallet/nonce")
        .send({ address: wallet.address });
      expect(nonceRes.status).toBe(200);
      const { nonce, message } = nonceRes.body as { nonce: string; message: string };
      const signature = await wallet.signMessage(message);
      return { address: wallet.address, signature, nonce };
    }

    it("requires authentication", async () => {
      const res = await request(app).post("/auth/link/wallet").send({});
      expect(res.status).toBe(401);
    });

    it("lets an email-first user attach a wallet without changing the session", async () => {
      const { res: regRes } = await registerUser();
      const cookie = sessionCookie(regRes);
      const sid = decodeURIComponent(cookie.split("=")[1] ?? "");
      trackedSids.push(sid);

      const signer = ethers.Wallet.createRandom();
      trackedAddresses.push(signer.address.toLowerCase());
      const proof = await walletProof(signer as unknown as ethers.Wallet);

      const res = await request(app)
        .post("/auth/link/wallet")
        .set("Cookie", cookie)
        .send(proof);
      expect(res.status).toBe(200);
      expect(res.body.walletAddress).toBe(signer.address.toLowerCase());
      expect(res.body.hasPassword).toBe(true);
    });

    it("409s when the account already has a wallet", async () => {
      const wallet = await createWalletUser();
      trackedUserIds.push(wallet.id);
      trackedSids.push(wallet.sid);
      const res = await request(app)
        .post("/auth/link/wallet")
        .set("Cookie", `${SESSION_COOKIE}=${wallet.sid}`)
        .send({ address: wallet.address, signature: "0x0", nonce: "junk" });
      expect(res.status).toBe(409);
    });

    it("409s when the wallet is already linked to another account", async () => {
      const existing = await createWalletUser();
      trackedUserIds.push(existing.id);
      trackedSids.push(existing.sid);

      const { res: regRes } = await registerUser();
      const cookie = sessionCookie(regRes);
      trackedSids.push(decodeURIComponent(cookie.split("=")[1] ?? ""));

      // A fresh signer whose signature is valid, but we then swap the DB row
      // so the address collides. Simpler: sign for a random wallet, link it to
      // the existing user first via direct DB update... Instead: point the
      // existing user's wallet_address at our signer's address up-front.
      const signer = ethers.Wallet.createRandom();
      trackedAddresses.push(signer.address.toLowerCase());
      await db
        .update(usersTable)
        .set({ walletAddress: signer.address.toLowerCase() })
        .where(eq(usersTable.id, existing.id));

      const proof = await walletProof(signer as unknown as ethers.Wallet);
      const res = await request(app)
        .post("/auth/link/wallet")
        .set("Cookie", cookie)
        .send(proof);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already linked/i);
    });

    it("rejects a bad signature", async () => {
      const { res: regRes } = await registerUser();
      const cookie = sessionCookie(regRes);
      trackedSids.push(decodeURIComponent(cookie.split("=")[1] ?? ""));

      const signer = ethers.Wallet.createRandom();
      const other = ethers.Wallet.createRandom();
      const nonceRes = await request(app)
        .post("/auth/wallet/nonce")
        .send({ address: signer.address });
      const { nonce, message } = nonceRes.body as { nonce: string; message: string };
      const signature = await other.signMessage(message); // wrong key

      const res = await request(app)
        .post("/auth/link/wallet")
        .set("Cookie", cookie)
        .send({ address: signer.address, signature, nonce });
      expect(res.status).toBe(401);
    });
  });
});
