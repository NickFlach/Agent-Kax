import { ethers } from "ethers";
import { and, eq } from "drizzle-orm";
import { db, authChallengesTable } from "@workspace/db";

/**
 * Shared SIWE proof verification (task #52). Both login
 * (POST /auth/wallet/verify) and account linking (POST /auth/link/wallet)
 * need the exact same property — "the requester controls address X" —
 * so the lookup → canonical-payload check → signature recovery →
 * atomic consume pipeline lives here once. The canonical-payload rule
 * (ignore any client-supplied message, verify against the message we
 * stored at /nonce time) is the SIWE phishing fix from migration 0004
 * and must never be re-implemented by hand.
 */

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/; // 65 bytes hex = 130 chars

export type WalletProofResult =
  | { ok: true; address: string }
  | { ok: false; status: 400 | 401 | 409; error: string };

export async function consumeWalletProof(input: {
  address?: unknown;
  signature?: unknown;
  nonce?: unknown;
}): Promise<WalletProofResult> {
  const addressRaw = typeof input.address === "string" ? input.address : "";
  const signature = typeof input.signature === "string" ? input.signature : "";
  const nonce = typeof input.nonce === "string" ? input.nonce.toLowerCase() : "";
  if (!ADDRESS_RE.test(addressRaw) || !SIGNATURE_RE.test(signature) || !/^[0-9a-f]+$/.test(nonce)) {
    return { ok: false, status: 400, error: "address, signature, and nonce are required" };
  }
  const address = addressRaw.toLowerCase();
  // Look up the nonce — must exist, match address, be unconsumed + unexpired.
  const [challenge] = await db
    .select()
    .from(authChallengesTable)
    .where(and(
      eq(authChallengesTable.kind, "wallet_nonce"),
      eq(authChallengesTable.challenge, nonce),
    ))
    .limit(1);
  if (!challenge || challenge.consumed || challenge.claimSubject !== address || challenge.expiresAt < new Date()) {
    return { ok: false, status: 401, error: "nonce invalid, expired, or already used" };
  }
  const canonicalMessage = challenge.payload;
  if (!canonicalMessage || canonicalMessage.length < 50) {
    // Pre-0004 row without stored payload — refuse rather than fall
    // through to the unsafe path. Client must request a fresh nonce.
    return { ok: false, status: 409, error: "stale nonce — please request a new one" };
  }
  // Recover the signer from the canonical SIWE message. ethers handles
  // the "personal_sign" \x19Ethereum Signed Message:\n<len> prefix.
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(canonicalMessage, signature).toLowerCase();
  } catch {
    return { ok: false, status: 401, error: "signature verification failed" };
  }
  if (recovered !== address) {
    return { ok: false, status: 401, error: "signature does not match address" };
  }
  // Atomically consume the nonce. If a concurrent request beats us to
  // it, the update affects 0 rows — bail. This also means a race
  // between login-verify and link-verify collapses to a single winner.
  const consumed = await db
    .update(authChallengesTable)
    .set({ consumed: true })
    .where(and(
      eq(authChallengesTable.id, challenge.id),
      eq(authChallengesTable.consumed, false),
    ))
    .returning();
  if (consumed.length === 0) {
    return { ok: false, status: 409, error: "nonce raced — please try again" };
  }
  return { ok: true, address };
}
