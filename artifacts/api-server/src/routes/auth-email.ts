import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  RegisterWithEmailBody,
  RegisterWithEmailResponse,
  LoginWithEmailBody,
  LoginWithEmailResponse,
  LinkEmailBody,
  LinkEmailResponse,
  LinkWalletResponse,
} from "@workspace/api-zod";
import { createSession, SESSION_COOKIE, SESSION_TTL } from "../lib/auth";
import { requireAuth } from "../middlewares/requireAuth";
import { hashPassword, verifyPassword, dummyVerify } from "../lib/password";
import { createRateLimiter } from "../lib/rateLimit";
import { consumeWalletProof } from "../lib/walletProof";

/**
 * Email + password door (task #52) and account linking. Wallet stays
 * the canonical crypto-native path; this adds a second, equal door
 * into the SAME users row. Linking endpoints let one account carry
 * both methods.
 */

const router: IRouter = Router();

// Exported so tests can reset the windows between cases.
export const registerLimiter = createRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
export const loginLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });

function clientIp(req: Request): string {
  return req.ip ?? "unknown";
}

/** PG unique_violation — raced or duplicate insert/update. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e.code === "23505" || (typeof e.cause === "object" && e.cause !== null && e.cause.code === "23505");
}

type UserRow = typeof usersTable.$inferSelect;

async function openSession(res: Response, user: UserRow): Promise<void> {
  // Same shape + cookie options as the wallet door (auth-wallet.ts).
  // `access_token` is a synthetic marker, not a real token — the
  // "email:" prefix records which door opened this session.
  const sid = await createSession({
    user: {
      id: user.id,
      email: user.email ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      profileImageUrl: user.profileImageUrl ?? null,
    },
    access_token: `email:${user.id}`,
    expires_at: Math.floor((Date.now() + SESSION_TTL) / 1000),
  });
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL,
    path: "/",
  });
}

function authUserPayload(user: UserRow) {
  return {
    id: user.id,
    email: user.email ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    profileImageUrl: user.profileImageUrl ?? null,
    displayName: user.displayName ?? null,
    role: user.role,
    walletAddress: user.walletAddress ?? null,
    provider: "email",
    hasPassword: Boolean(user.passwordHash),
  };
}

function methodsPayload(user: UserRow) {
  return {
    email: user.email ?? null,
    walletAddress: user.walletAddress ?? null,
    hasPassword: Boolean(user.passwordHash),
  };
}

/**
 * POST /auth/email/register — create an account and sign in.
 * Rate-limited per IP (mass account creation). Relies on the DB
 * unique constraint for duplicate emails (23505 → 409), never
 * check-then-insert.
 */
router.post("/auth/email/register", async (req, res) => {
  if (!registerLimiter.hit(`ip:${clientIp(req)}`)) {
    res.status(429).json({ error: "too many registration attempts — try again later" });
    return;
  }
  const parsed = RegisterWithEmailBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "enter a valid email and a password of at least 8 characters" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const displayName = (parsed.data.displayName ?? "").trim() || email.split("@")[0]!;
  const passwordHash = await hashPassword(parsed.data.password);
  let user: UserRow;
  try {
    const inserted = await db
      .insert(usersTable)
      .values({ email, passwordHash, authProvider: "email", displayName })
      .returning();
    user = inserted[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "that email is already registered — sign in instead" });
      return;
    }
    throw err;
  }
  await openSession(res, user);
  res.json(RegisterWithEmailResponse.parse({ user: authUserPayload(user) }));
});

/**
 * POST /auth/email/login — sign in with email + password.
 * Deliberately generic 401 for unknown email, wrong password, or an
 * account with no password set; a dummy scrypt compare keeps the
 * unknown-email path from being detectably faster.
 */
router.post("/auth/email/login", async (req, res) => {
  const parsed = LoginWithEmailBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const ipKey = `ip:${clientIp(req)}`;
  const emailKey = `email:${email}`;
  const ipAllowed = loginLimiter.hit(ipKey);
  const emailAllowed = loginLimiter.hit(emailKey);
  if (!ipAllowed || !emailAllowed) {
    res.status(429).json({ error: "too many attempts — try again in a few minutes" });
    return;
  }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (!user || !user.passwordHash) {
    await dummyVerify(parsed.data.password);
    res.status(401).json({ error: "invalid email or password" });
    return;
  }
  const passwordOk = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!passwordOk) {
    res.status(401).json({ error: "invalid email or password" });
    return;
  }
  if (user.disabledAt) {
    res.status(403).json({ error: "account disabled" });
    return;
  }
  // Successful sign-in — forgive this email's window so a legitimate
  // user can't lock themselves out by logging in repeatedly.
  loginLimiter.clear(emailKey);
  await openSession(res, user);
  res.json(LoginWithEmailResponse.parse({ user: authUserPayload(user) }));
});

/**
 * POST /auth/link/email — set email + password on the signed-in
 * account (wallet-first users adding the email door). Allowed when no
 * password is set yet, even if the row already carries that same
 * email; changing an existing password is out of scope.
 */
router.post("/auth/link/email", requireAuth, async (req, res) => {
  const parsed = LinkEmailBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "enter a valid email and a password of at least 8 characters" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id))
    .limit(1);
  if (!user) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  if (user.passwordHash) {
    res.status(409).json({ error: "a password is already set on this account" });
    return;
  }
  if (user.email && user.email.toLowerCase() !== email) {
    res.status(409).json({ error: "this account already has a different email" });
    return;
  }
  const passwordHash = await hashPassword(parsed.data.password);
  try {
    const [updated] = await db
      .update(usersTable)
      .set({ email, passwordHash })
      .where(eq(usersTable.id, user.id))
      .returning();
    res.json(LinkEmailResponse.parse(methodsPayload(updated!)));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "that email is already in use by another account" });
      return;
    }
    throw err;
  }
});

/**
 * POST /auth/link/wallet — attach a wallet to the signed-in account
 * (email-first users adding the wallet door). Reuses the exact SIWE
 * proof pipeline from /auth/wallet/verify via consumeWalletProof; the
 * session is NOT touched — the user stays signed in as themselves.
 */
router.post("/auth/link/wallet", requireAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id))
    .limit(1);
  if (!user) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  if (user.walletAddress) {
    res.status(409).json({ error: "this account already has a linked wallet" });
    return;
  }
  const proof = await consumeWalletProof({
    address: body.address,
    signature: body.signature,
    nonce: body.nonce,
  });
  if (!proof.ok) {
    res.status(proof.status).json({ error: proof.error });
    return;
  }
  try {
    const [updated] = await db
      .update(usersTable)
      .set({ walletAddress: proof.address })
      .where(eq(usersTable.id, user.id))
      .returning();
    res.json(LinkWalletResponse.parse(methodsPayload(updated!)));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "that wallet is already linked to another account" });
      return;
    }
    throw err;
  }
});

export default router;
