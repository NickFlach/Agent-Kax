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
  const addressRaw = typeof body.address === "string" ? body.address : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const nonce = typeof body.nonce === "string" ? body.nonce.toLowerCase() : "";
  if (!ADDRESS_RE.test(addressRaw) || !SIGNATURE_RE.test(signature) || !/^[0-9a-f]+$/.test(nonce)) {
    res.status(400).json({ error: "address, signature, and nonce are required" });
    return;
  }
  const address = addressRaw.toLowerCase();
  // Look up the nonce — must exist, match address, be unconsumed + unexpired.
  // We ignore any client-supplied `message` field and use the canonical
  // payload stored at /nonce time. Without this, an attacker who got
  // a victim to sign ANY message containing a valid nonce (via phishing
  // wallet popups) could replay that signature here to mint a session
  // in the victim's name. See migration 0004.
  const [challenge] = await db
    .select()
    .from(authChallengesTable)
    .where(and(
      eq(authChallengesTable.kind, "wallet_nonce"),
      eq(authChallengesTable.challenge, nonce),
    ))
    .limit(1);
  if (!challenge || challenge.consumed || challenge.claimSubject !== address || challenge.expiresAt < new Date()) {
    res.status(401).json({ error: "nonce invalid, expired, or already used" });
    return;
  }
  const canonicalMessage = challenge.payload;
  if (!canonicalMessage || canonicalMessage.length < 50) {
    // Pre-0004 row without stored payload — refuse rather than fall
    // through to the unsafe path. Client must request a fresh nonce.
    res.status(409).json({ error: "stale nonce — please request a new one" });
    return;
  }
  // Recover the signer from the canonical SIWE message. ethers handles
  // the "personal_sign" \x19Ethereum Signed Message:\n<len> prefix
  // when given the raw message + signature.
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(canonicalMessage, signature).toLowerCase();
  } catch (err) {
    res.status(401).json({ error: "signature verification failed" });
    return;
  }
  if (recovered !== address) {
    res.status(401).json({ error: "signature does not match address" });
    return;
  }
  // Atomically consume the nonce. If another concurrent request beats
  // us to it, the update will affect 0 rows — bail.
  const consumed = await db
    .update(authChallengesTable)
    .set({ consumed: true })
    .where(and(
      eq(authChallengesTable.id, challenge.id),
      eq(authChallengesTable.consumed, false),
    ))
    .returning();
  if (consumed.length === 0) {
    res.status(409).json({ error: "nonce raced — please try again" });
    return;
  }
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
