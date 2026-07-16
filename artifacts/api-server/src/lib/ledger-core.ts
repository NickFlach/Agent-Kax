import crypto from "node:crypto";

/**
 * Pure, DB-free core of the double-entry hash-chained ledger (ADR-0041 Phase 2).
 * The security-critical invariants live here so they can be tested without a
 * database. lib/ledger.ts wraps these with drizzle persistence.
 */

// The chain's genesis: the prevHash of the very first entry.
export const GENESIS_HASH = "GENESIS::credit-ledger::v1";

// The single designated issuer/mint account. It is exempt from the
// non-negativity (overdraft) guard — it is allowed to go negative, because it
// IS the source of minted credits. Every other account must stay >= 0.
export const HOUSE_ACCOUNT = "house";

// Upper bound on postings in one transaction, so a single request can't blow up
// memory / boot verification. Generous enough for a batched resolve.
export const MAX_POSTINGS_PER_TX = 10_000;

export interface Posting {
  account: string;
  amount: bigint; // signed integer minor units
  kind: string;
  ref?: string | null;
}

export interface HashedEntry {
  txId: string;
  asset: string;
  account: string;
  amount: bigint;
  kind: string;
  ref?: string | null;
}

/**
 * Canonical byte serialization of the fields an entry commits to. Field order
 * is fixed and the amount is stringified so the hash is stable and
 * language-agnostic. `prevHash` chains this entry to its predecessor.
 */
function canonical(prevHash: string, e: HashedEntry): string {
  return JSON.stringify([
    prevHash,
    e.txId,
    e.asset,
    e.account,
    e.amount.toString(),
    e.kind,
    e.ref ?? null,
  ]);
}

export function computeEntryHash(prevHash: string, e: HashedEntry): string {
  return crypto.createHash("sha256").update(canonical(prevHash, e)).digest("hex");
}

/**
 * Validate one transaction's postings: at least two, all integer bigints, a
 * single asset, and — the double-entry invariant — signed amounts summing to
 * exactly zero. Throws on any violation. Value is only moved, never conjured
 * (an explicit house/mint account must be one of the balanced postings).
 */
export function validatePostings(postings: Posting[], asset: string): void {
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new Error("a transaction needs at least two postings (double-entry)");
  }
  if (postings.length > MAX_POSTINGS_PER_TX) {
    throw new Error(`too many postings in one transaction (max ${MAX_POSTINGS_PER_TX})`);
  }
  if (!asset) throw new Error("asset is required");
  let sum = 0n;
  for (const p of postings) {
    if (typeof p.amount !== "bigint") throw new Error("amount must be a bigint (integer minor units)");
    if (!p.account || !p.kind) throw new Error("each posting needs an account and a kind");
    sum += p.amount;
  }
  if (sum !== 0n) throw new Error(`postings must sum to zero (double-entry); got ${sum.toString()}`);
}

/**
 * A canonical hash of a transaction's *content* (txId + asset + ordered
 * postings). Stored in the idempotency registry so a replayed txId can be
 * confirmed to carry the SAME postings — a replay with different content is a
 * bug and must be rejected, not silently succeed.
 */
export function canonicalPostingsHash(txId: string, asset: string, postings: Posting[]): string {
  const body = JSON.stringify([
    txId,
    asset,
    postings.map((p) => [p.account, p.amount.toString(), p.kind, p.ref ?? null]),
  ]);
  return crypto.createHash("sha256").update(body).digest("hex");
}

export interface ChainRow extends HashedEntry {
  seq: number;
  prevHash: string;
  entryHash: string;
}

/**
 * Recompute the whole chain from genesis and confirm every entry's hash and
 * link. Returns the verified head hash. Throws at the first broken link — used
 * both as an audit and as a boot-time integrity check.
 */
export function verifyChain(entries: ChainRow[]): string {
  let prev = GENESIS_HASH;
  for (const e of entries) {
    if (e.prevHash !== prev) throw new Error(`chain link broken at seq ${e.seq}: prevHash mismatch`);
    const h = computeEntryHash(prev, {
      txId: e.txId, asset: e.asset, account: e.account, amount: e.amount, kind: e.kind, ref: e.ref,
    });
    if (h !== e.entryHash) throw new Error(`chain hash broken at seq ${e.seq}: entryHash mismatch`);
    prev = h;
  }
  return prev;
}

/** Derive an account's balance for an asset by summing its postings. */
export function deriveBalance(entries: Pick<ChainRow, "account" | "asset" | "amount">[], account: string, asset: string): bigint {
  let bal = 0n;
  for (const e of entries) {
    if (e.account === account && e.asset === asset) bal += typeof e.amount === "bigint" ? e.amount : BigInt(e.amount as unknown as string);
  }
  return bal;
}

/**
 * Compute the ordered rows for a transaction, chaining each posting to the
 * running head. Pure — the caller persists them atomically. Postings within a
 * transaction all share the txId and asset and are chained in array order.
 */
export function buildTransactionRows(headHash: string, txId: string, asset: string, postings: Posting[]): Omit<ChainRow, "seq">[] {
  validatePostings(postings, asset);
  let prev = headHash;
  const rows: Omit<ChainRow, "seq">[] = [];
  for (const p of postings) {
    const entry: HashedEntry = { txId, asset, account: p.account, amount: p.amount, kind: p.kind, ref: p.ref ?? null };
    const entryHash = computeEntryHash(prev, entry);
    rows.push({ ...entry, prevHash: prev, entryHash });
    prev = entryHash;
  }
  return rows;
}
