import crypto from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";

/**
 * npub↔bot binding commitment (ADR-0043 Phase 0, Plane 1).
 *
 * The message the npub holder signs to prove control AND bind the key to a
 * specific (bot, user, nonce). Built as a domain-separated canonical JSON
 * array so it is:
 *   - unambiguous: JSON delimits fields, so no `a‖b` concatenation collision;
 *   - domain-separated: the first element is the string tag
 *     "kax:npub-bind:v1", whereas a NIP-01 event id hashes an array whose
 *     first element is the integer 0. The preimages can never coincide, so a
 *     signature gathered here can NEVER be replayed as a signed Nostr event
 *     (and vice-versa). This is the load-bearing safety property — never sign
 *     an opaque digest handed over by the server.
 *
 * Returns the 32-byte sha256 digest (BIP-340 message) the client signs and the
 * server verifies. Both sides MUST build it identically.
 */
export const NPUB_BIND_TAG = "kax:npub-bind:v1";

export function npubBindDigest(params: {
  domain: string;
  npub: string;
  botId: string;
  userId: string;
  nonce: string;
}): Buffer {
  const canonical = JSON.stringify([
    NPUB_BIND_TAG,
    params.domain,
    params.npub,
    params.botId,
    params.userId,
    params.nonce,
  ]);
  return crypto.createHash("sha256").update(canonical, "utf8").digest();
}

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/**
 * Decode an `npub1…` (NIP-19) to its 32-byte x-only public key (hex).
 * Minimal bech32 decoder (no external dep): validates the `npub` HRP, the
 * checksum, and 5→8 bit regrouping. Returns null on any malformation
 * (fail-closed — an unparseable npub must never verify).
 */
export function npubToXOnlyHex(npub: string): string | null {
  const lower = npub.toLowerCase();
  if (npub !== lower && npub !== npub.toUpperCase()) return null; // mixed case
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  if (hrp !== "npub") return null;
  const dataChars = lower.slice(pos + 1);
  const data: number[] = [];
  for (const ch of dataChars) {
    const v = BECH32_ALPHABET.indexOf(ch);
    if (v === -1) return null;
    data.push(v);
  }
  if (!bech32VerifyChecksum(hrp, data)) return null;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  if (!bytes || bytes.length !== 32) return null;
  return Buffer.from(bytes).toString("hex");
}

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function bech32VerifyChecksum(hrp: string, data: number[]): boolean {
  return bech32Polymod(hrpExpand(hrp).concat(data)) === 1;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

/**
 * Verify a BIP-340 schnorr signature (hex, 64 bytes) from `npub` over the
 * binding digest. Returns true iff valid. Fails closed on any decode error.
 */
export function verifyNpubBinding(params: {
  npub: string;
  sigHex: string;
  domain: string;
  botId: string;
  userId: string;
  nonce: string;
}): boolean {
  const pubHex = npubToXOnlyHex(params.npub);
  if (!pubHex) return false;
  if (!/^[0-9a-f]{128}$/i.test(params.sigHex)) return false;
  const digest = npubBindDigest({
    domain: params.domain,
    npub: params.npub,
    botId: params.botId,
    userId: params.userId,
    nonce: params.nonce,
  });
  try {
    // BIP-340: verify over the RAW 32-byte message (the digest), not a
    // re-hash of it — matching the Nostr/kannaka signer.
    return schnorr.verify(params.sigHex, digest, pubHex);
  } catch {
    return false;
  }
}
