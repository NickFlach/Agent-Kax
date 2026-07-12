import { Router } from "express";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { and, eq, lt } from "drizzle-orm";
import {
  db,
  usersTable,
  authChallengesTable,
} from "@workspace/db";
import { createSession, SESSION_COOKIE, SESSION_TTL } from "../lib/auth";
import { consumeWalletProof } from "../lib/walletProof";

const router: Router = Router();

const NONCE_TTL_MS = 10 * 60 * 1000; // 10 min — generous for slow human flows
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/; // 65 bytes hex = 130 chars

/**
 * The SIWE message the user signs. Plain English on top so the wallet
 * popup is readable, structured fields below so the server can verify
 * by reconstruction. Per EIP-4361 the server controls every field —
 * the user signs whatever the server wrote.
 */
function buildSiweMessage(opts: {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: string;
  uri: string;
}): string {
  return [
    `${opts.domain} wants you to sign in with your Ethereum account:`,
    opts.address,
    "",
    "Sign in to KAX (Kannaka Artifact Exchange). This signs you in; it does not authorize any token transfer.",
    "",
    `URI: ${opts.uri}`,
    `Version: 1`,
    `Chain ID: 1`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt}`,
  ].join("\n");
}

function publicDomain(req: { headers: { host?: string; "x-forwarded-host"?: string | string[] } }): string {
  const h = (req.headers["x-forwarded-host"] ?? req.headers.host) as string | undefined;
  return h ?? "kax.local";
}

/**
 * Step 1: client POSTs an address; server returns a fresh nonce + the
 * SIWE message text to sign. We persist the nonce so step 2 can verify
 * the user signed the same message we issued (replay protection).
 */
router.post("/auth/wallet/nonce", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = typeof body.address === "string" ? body.address : "";
  if (!ADDRESS_RE.test(raw)) {
    res.status(400).json({ error: "address must be 0x + 40 hex" });
    return;
  }
  const address = raw.toLowerCase();
  // Clean up expired nonces opportunistically. Cheap; bounded by index.
  await db.delete(authChallengesTable).where(
    and(eq(authChallengesTable.kind, "wallet_nonce"), lt(authChallengesTable.expiresAt, new Date())),
  );
  const nonce = crypto.randomBytes(12).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  const domain = publicDomain(req);
  const uri = `https://${domain}`;
  const message = buildSiweMessage({
    domain, address, nonce, issuedAt: issuedAt.toISOString(), uri,
  });
  // Persist the canonical message text alongside the nonce. /verify
  // reads `payload` and ignores any client-supplied message — that's
  // the SIWE phishing fix (see migration 0004).
  await db.insert(authChallengesTable).values({
    kind: "wallet_nonce",
    challenge: nonce,
    payload: message,
    claimSubject: address,
    consumed: false,
    expiresAt,
  });
  res.json({ nonce, message, expiresAt: expiresAt.toISOString() });
});

/**
 * Step 2: client posts the user's wallet signature over the message
 * issued in step 1. We recover the signing address from the signature
 * and confirm it matches the claimed address + the nonce is unconsumed
 * and unexpired. On success we upsert a user row (linking by wallet)
 * and issue a session cookie.
 */
router.post("/auth/wallet/verify", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Verification (input shape → nonce lookup → canonical-payload
  // signature check → atomic consume) is shared with /auth/link/wallet.
  // The canonical payload stored at /nonce time is used and any
  // client-supplied `message` ignored — the SIWE phishing fix, see
  // migration 0004 and lib/walletProof.ts.
  const proof = await consumeWalletProof({
    address: body.address,
    signature: body.signature,
    nonce: body.nonce,
  });
  if (!proof.ok) {
    res.status(proof.status).json({ error: proof.error });
    return;
  }
  const address = proof.address;
  // Upsert the user keyed by wallet address. New rows default to a
  // displayName of the truncated 0x…XXXX so something readable shows
  // in the UI before the user sets their own.
  let [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.walletAddress, address))
    .limit(1);
  if (!user) {
    const inserted = await db
      .insert(usersTable)
      .values({
        walletAddress: address,
        authProvider: "wallet",
        displayName: `0x…${address.slice(-4)}`,
      })
      .returning();
    user = inserted[0]!;
  }
  if (user.disabledAt) {
    res.status(403).json({ error: "account disabled" });
    return;
  }
  // Issue a session. SessionData carries access_token/refresh_token
  // for OIDC; we fill placeholder strings + a far-future expires_at so
  // the OIDC refresh path in authMiddleware is short-circuited.
  const sid = await createSession({
    user: {
      id: user.id,
      email: user.email ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      profileImageUrl: user.profileImageUrl ?? null,
    },
    access_token: `wallet:${user.id}`,
    expires_at: Math.floor((Date.now() + SESSION_TTL) / 1000),
  });
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL,
    path: "/",
  });
  res.json({
    ok: true,
    user: {
      id: user.id,
      walletAddress: user.walletAddress,
      displayName: user.displayName,
      role: user.role,
    },
  });
});

export default router;
