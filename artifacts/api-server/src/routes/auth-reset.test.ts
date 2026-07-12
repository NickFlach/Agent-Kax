import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable, authChallengesTable } from "@workspace/db/schema";
import authEmailRouter, {
  registerLimiter,
  loginLimiter,
  resetRequestLimiter,
  resetConfirmLimiter,
} from "./auth-email";
import { authMiddleware } from "../middlewares/authMiddleware";
import { cleanupAuthTestData, createWalletUser, makeTestId } from "../test-helpers";

/**
 * Forgot-password reset flow (task #53).
 *
 * reset-request detaches the token issue + email send from the
 * response (anti-timing), so tests poll the auth_challenges table for
 * the row instead of racing the response. reset-confirm is exercised
 * by minting tokens directly (same sha256 storage scheme the route
 * uses) — the raw token normally only exists inside the email.
 */

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(authEmailRouter);
  return app;
}

function makeEmail(label = "reset"): string {
  return `${makeTestId(label)}@example.test`;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function challengesFor(userId: string) {
  return db
    .select()
    .from(authChallengesTable)
    .where(
      and(
        eq(authChallengesTable.kind, "password_reset"),
        eq(authChallengesTable.claimSubject, userId),
      ),
    );
}

/** Poll until `fn` returns a truthy value or the deadline passes. */
async function waitFor<T>(fn: () => Promise<T | undefined | null>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Insert a reset challenge directly, returning the raw token. */
async function mintToken(userId: string, opts: { expired?: boolean } = {}): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.insert(authChallengesTable).values({
    kind: "password_reset",
    challenge: sha256Hex(token),
    claimSubject: userId,
    expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 30 * 60_000)),
  });
  return token;
}

const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "brand-new-password-9";

describe("auth-reset", () => {
  let app: Express;
  const trackedEmails: string[] = [];
  const trackedUserIds: string[] = [];
  const trackedSids: string[] = [];

  function resetLimiters() {
    registerLimiter.reset();
    loginLimiter.reset();
    resetRequestLimiter.reset();
    resetConfirmLimiter.reset();
  }

  beforeEach(() => {
    app = buildApp();
    resetLimiters();
  });

  afterEach(async () => {
    for (const uid of trackedUserIds) {
      await db.delete(authChallengesTable).where(eq(authChallengesTable.claimSubject, uid));
    }
    await cleanupAuthTestData({
      emails: trackedEmails.splice(0),
      userIds: trackedUserIds.splice(0),
      sids: trackedSids.splice(0),
    });
    resetLimiters();
  });

  async function registerUser(email = makeEmail()) {
    trackedEmails.push(email);
    const res = await request(app).post("/auth/email/register").send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    const userId = res.body.user.id as string;
    trackedUserIds.push(userId);
    return { email, userId };
  }

  describe("POST /auth/email/reset-request", () => {
    it("rejects an invalid email with 400", async () => {
      const res = await request(app).post("/auth/email/reset-request").send({ email: "nope" });
      expect(res.status).toBe(400);
    });

    it("answers the same generic 200 for known and unknown emails", async () => {
      const { email } = await registerUser();
      const known = await request(app).post("/auth/email/reset-request").send({ email });
      const unknown = await request(app)
        .post("/auth/email/reset-request")
        .send({ email: makeEmail("ghost") });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(known.body).toEqual(unknown.body);
    });

    it("stores a hashed single-use challenge for an account with a password", async () => {
      const { email, userId } = await registerUser();
      const res = await request(app).post("/auth/email/reset-request").send({ email });
      expect(res.status).toBe(200);

      const challenge = await waitFor(async () => (await challengesFor(userId))[0]);
      expect(challenge.consumed).toBe(false);
      // sha256 hex, not a raw token
      expect(challenge.challenge).toMatch(/^[0-9a-f]{64}$/);
      expect(challenge.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("does not issue a token for a wallet-only account (no password)", async () => {
      const wallet = await createWalletUser();
      trackedUserIds.push(wallet.id);
      trackedSids.push(wallet.sid);
      const email = makeEmail("walletonly");
      trackedEmails.push(email);
      await db.update(usersTable).set({ email }).where(eq(usersTable.id, wallet.id));

      const res = await request(app).post("/auth/email/reset-request").send({ email });
      expect(res.status).toBe(200); // still generic
      // Give the detached issue path time to (not) run.
      await new Promise((r) => setTimeout(r, 300));
      expect(await challengesFor(wallet.id)).toHaveLength(0);
    });

    it("rate-limits repeated requests for the same email", async () => {
      const email = makeEmail("limited");
      for (let i = 0; i < 5; i++) {
        resetRequestLimiter.clear(`ip:${"::ffff:127.0.0.1"}`);
        const res = await request(app).post("/auth/email/reset-request").send({ email });
        // first five may pass or trip the shared ip key; only the email
        // key matters for the final assertion
        expect([200, 429]).toContain(res.status);
      }
      const res = await request(app).post("/auth/email/reset-request").send({ email });
      expect(res.status).toBe(429);
    });
  });

  describe("POST /auth/email/reset-confirm", () => {
    it("sets the new password, invalidates the token, and old password stops working", async () => {
      const { email, userId } = await registerUser();
      const token = await mintToken(userId);

      const res = await request(app)
        .post("/auth/email/reset-confirm")
        .send({ token, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // old password rejected, new one works
      const oldLogin = await request(app)
        .post("/auth/email/login")
        .send({ email, password: PASSWORD });
      expect(oldLogin.status).toBe(401);
      const newLogin = await request(app)
        .post("/auth/email/login")
        .send({ email, password: NEW_PASSWORD });
      expect(newLogin.status).toBe(200);

      // token is single-use
      const replay = await request(app)
        .post("/auth/email/reset-confirm")
        .send({ token, newPassword: "another-new-password" });
      expect(replay.status).toBe(400);
    });

    it("voids every other outstanding token for the account on success", async () => {
      const { userId } = await registerUser();
      const tokenA = await mintToken(userId);
      const tokenB = await mintToken(userId);

      const res = await request(app)
        .post("/auth/email/reset-confirm")
        .send({ token: tokenA, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(200);

      const second = await request(app)
        .post("/auth/email/reset-confirm")
        .send({ token: tokenB, newPassword: "yet-another-pass1" });
      expect(second.status).toBe(400);

      const rows = await challengesFor(userId);
      expect(rows.every((r) => r.consumed)).toBe(true);
    });

    it("rejects expired and garbage tokens with the same generic 400", async () => {
      const { userId } = await registerUser();
      const expired = await mintToken(userId, { expired: true });

      const expiredRes = await request(app)
        .post("/auth/email/reset-confirm")
        .send({ token: expired, newPassword: NEW_PASSWORD });
      const garbageRes = await request(app)
        .post("/auth/email/reset-confirm")
        .send({ token: "not-a-real-token", newPassword: NEW_PASSWORD });
      expect(expiredRes.status).toBe(400);
      expect(garbageRes.status).toBe(400);
      expect(expiredRes.body.error).toBe(garbageRes.body.error);
    });

    it("rejects a too-short new password with 400 without consuming the token", async () => {
      const { userId } = await registerUser();
      const token = await mintToken(userId);

      const res = await request(app)
        .post("/auth/email/reset-confirm")
        .send({ token, newPassword: "short" });
      expect(res.status).toBe(400);

      // token still valid for a correct attempt
      const ok = await request(app)
        .post("/auth/email/reset-confirm")
        .send({ token, newPassword: NEW_PASSWORD });
      expect(ok.status).toBe(200);
    });

    it("rate-limits confirm attempts per IP", async () => {
      for (let i = 0; i < 10; i++) {
        await request(app)
          .post("/auth/email/reset-confirm")
          .send({ token: `guess-${i}`, newPassword: NEW_PASSWORD });
      }
      const res = await request(app)
        .post("/auth/email/reset-confirm")
        .send({ token: "guess-final", newPassword: NEW_PASSWORD });
      expect(res.status).toBe(429);
    });
  });
});
