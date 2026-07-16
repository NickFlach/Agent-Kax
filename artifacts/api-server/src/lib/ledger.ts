import { db } from "@workspace/db";
import { creditLedgerTable, creditLedgerTxidsTable } from "@workspace/db/schema";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import {
  GENESIS_HASH,
  HOUSE_ACCOUNT,
  buildTransactionRows,
  canonicalPostingsHash,
  deriveBalance,
  validatePostings,
  verifyChain,
  type ChainRow,
  type Posting,
} from "./ledger-core";

// A single advisory-lock key serializes ALL ledger appends into a FIFO queue,
// so concurrent transactions never optimistically collide on UNIQUE(prev_hash)
// (which caused retry-thrash / spurious failures under load — a review finding).
// The UNIQUE(prev_hash) constraint stays as an integrity backstop.
const LEDGER_ADVISORY_KEY = 0x1ed6e401;

/** Business errors the write endpoints map to specific HTTP statuses. */
export class LedgerInsufficientFunds extends Error {
  readonly code = "insufficient_funds";
  constructor(public account: string) {
    super(`insufficient funds: ${account} would go negative`);
  }
}
export class LedgerIdempotencyConflict extends Error {
  readonly code = "idempotency_conflict";
  constructor(public txId: string) {
    super(`txId ${txId} already recorded with DIFFERENT postings`);
  }
}

/** SQLSTATE + violated-constraint name of a pg error, if any. */
function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return { code: e?.code ?? e?.cause?.code, constraint: e?.constraint ?? e?.cause?.constraint };
}

export interface PostTxInput {
  txId: string;
  asset: string;
  postings: Posting[];
}

/**
 * Append one balanced transaction to the ledger atomically. All postings are
 * inserted in a single DB transaction, each chained to the running head. If a
 * concurrent append races us (its first posting claims the same predecessor —
 * a UNIQUE(prevHash) violation), we re-read the new head and retry, so the
 * chain stays linear and fork-free.
 */
export interface PostResult {
  txId: string;
  head: string;
  count: number;
  idempotentReplay: boolean;
}

export async function postTransaction(input: PostTxInput): Promise<PostResult> {
  validatePostings(input.postings, input.asset);
  const postingsHash = canonicalPostingsHash(input.txId, input.asset, input.postings);
  let lastErr: unknown;

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        // Serialize ALL appends FIFO — no optimistic prev_hash collisions.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${LEDGER_ADVISORY_KEY})`);

        // Idempotency: a replay of this txId returns the ORIGINAL result and
        // applies nothing. A replay with different postings is a caller bug.
        const [rec] = await tx
          .select()
          .from(creditLedgerTxidsTable)
          .where(eq(creditLedgerTxidsTable.txId, input.txId))
          .limit(1);
        if (rec) {
          if (rec.postingsHash !== postingsHash) throw new LedgerIdempotencyConflict(input.txId);
          return { txId: input.txId, head: rec.head, count: rec.entryCount, idempotentReplay: true };
        }

        // Overdraft guard: every debited non-house account must stay >= 0. The
        // SUM is consistent because we hold the advisory lock, so no other
        // append can commit between this read and our insert.
        for (const p of input.postings) {
          if (p.amount < 0n && p.account !== HOUSE_ACCOUNT) {
            const [b] = await tx
              .select({ bal: sql<string>`COALESCE(SUM(${creditLedgerTable.amount}), 0)` })
              .from(creditLedgerTable)
              .where(and(eq(creditLedgerTable.account, p.account), eq(creditLedgerTable.asset, input.asset)));
            if (BigInt(b?.bal ?? "0") + p.amount < 0n) throw new LedgerInsufficientFunds(p.account);
          }
        }

        const [head] = await tx
          .select({ entryHash: creditLedgerTable.entryHash })
          .from(creditLedgerTable)
          .orderBy(desc(creditLedgerTable.seq))
          .limit(1);
        const headHash = head ? head.entryHash : GENESIS_HASH;
        const rows = buildTransactionRows(headHash, input.txId, input.asset, input.postings);
        const newHead = rows[rows.length - 1].entryHash;

        await tx.insert(creditLedgerTable).values(
          rows.map((r) => ({
            entryHash: r.entryHash,
            prevHash: r.prevHash,
            txId: r.txId,
            asset: r.asset,
            account: r.account,
            amount: r.amount,
            kind: r.kind,
            ref: r.ref ?? null,
          })),
        );
        await tx.insert(creditLedgerTxidsTable).values({
          txId: input.txId,
          postingsHash,
          head: newHead,
          entryCount: rows.length,
        });
        return { txId: input.txId, head: newHead, count: rows.length, idempotentReplay: false };
      });
    } catch (err) {
      // Business errors propagate as-is (the route maps them to 409).
      if (err instanceof LedgerInsufficientFunds || err instanceof LedgerIdempotencyConflict) throw err;
      lastErr = err;
      const { code, constraint } = pgError(err);
      if (code === "23505") {
        // A concurrent duplicate txId committed first (should be rare under the
        // advisory lock) — return its recorded result instead of retry-appending.
        if (constraint === "credit_ledger_txids_pkey") {
          const [rec] = await db
            .select()
            .from(creditLedgerTxidsTable)
            .where(eq(creditLedgerTxidsTable.txId, input.txId))
            .limit(1);
          if (rec) {
            if (rec.postingsHash !== postingsHash) throw new LedgerIdempotencyConflict(input.txId);
            return { txId: input.txId, head: rec.head, count: rec.entryCount, idempotentReplay: true };
          }
        }
        // prev_hash / entry_hash fork — retry against the new head.
        continue;
      }
      throw err;
    }
  }
  throw new Error(`ledger append failed after retries: ${(lastErr as Error)?.message ?? lastErr}`);
}

/** Fetch a recorded transaction by txId (for cross-service reconciliation). */
export async function getTransaction(txId: string): Promise<{ txId: string; head: string; count: number; postingsHash: string } | null> {
  const [rec] = await db
    .select()
    .from(creditLedgerTxidsTable)
    .where(eq(creditLedgerTxidsTable.txId, txId))
    .limit(1);
  return rec ? { txId: rec.txId, head: rec.head, count: rec.entryCount, postingsHash: rec.postingsHash } : null;
}

/**
 * Total value that has left the house account for a given kind+asset since an
 * instant — i.e. the positive outflow (house debits are negative; we negate the
 * sum). Used to enforce a per-day mint cap on `/ledger/grant` so a compromised
 * mint token can't drain the house in one burst. Best-effort (a small race
 * window across concurrent grants is acceptable for play credits).
 */
export async function houseOutflow(kind: string, asset: string, since: Date): Promise<bigint> {
  const [row] = await db
    .select({ s: sql<string>`COALESCE(SUM(${creditLedgerTable.amount}), 0)` })
    .from(creditLedgerTable)
    .where(
      and(
        eq(creditLedgerTable.account, HOUSE_ACCOUNT),
        eq(creditLedgerTable.asset, asset),
        eq(creditLedgerTable.kind, kind),
        gte(creditLedgerTable.createdAt, since),
      ),
    );
  return -BigInt(row?.s ?? "0");
}

/** An account's balance for an asset, derived by summing its postings in the DB. */
export async function balance(account: string, asset: string): Promise<bigint> {
  const [row] = await db
    .select({ bal: sql<string>`COALESCE(SUM(${creditLedgerTable.amount}), 0)` })
    .from(creditLedgerTable)
    .where(and(eq(creditLedgerTable.account, account), eq(creditLedgerTable.asset, asset)));
  return BigInt(row?.bal ?? "0");
}

/** Recompute and verify the entire chain from genesis. Returns the head hash. */
export async function verifyLedgerChain(): Promise<{ ok: true; head: string; entries: number } | { ok: false; error: string }> {
  try {
    const rows = await db.select().from(creditLedgerTable).orderBy(asc(creditLedgerTable.seq));
    const chain: ChainRow[] = rows.map((r) => ({
      seq: r.seq,
      prevHash: r.prevHash,
      entryHash: r.entryHash,
      txId: r.txId,
      asset: r.asset,
      account: r.account,
      amount: r.amount,
      kind: r.kind,
      ref: r.ref,
    }));
    const head = verifyChain(chain);
    return { ok: true, head, entries: chain.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export { deriveBalance };
