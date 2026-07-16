import { db } from "@workspace/db";
import { creditLedgerTable } from "@workspace/db/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  GENESIS_HASH,
  buildTransactionRows,
  deriveBalance,
  validatePostings,
  verifyChain,
  type ChainRow,
  type Posting,
} from "./ledger-core";

/** True for a Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } })?.code
    ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
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
export async function postTransaction(input: PostTxInput): Promise<{ txId: string; head: string; count: number }> {
  validatePostings(input.postings, input.asset);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [head] = await tx
          .select({ entryHash: creditLedgerTable.entryHash })
          .from(creditLedgerTable)
          .orderBy(desc(creditLedgerTable.seq))
          .limit(1);
        const headHash = head ? head.entryHash : GENESIS_HASH;
        const rows = buildTransactionRows(headHash, input.txId, input.asset, input.postings);
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
        return { txId: input.txId, head: rows[rows.length - 1].entryHash, count: rows.length };
      });
    } catch (err) {
      lastErr = err;
      if (isUniqueViolation(err)) continue; // fork raced — retry against the new head
      throw err;
    }
  }
  throw new Error(`ledger append failed after retries: ${(lastErr as Error)?.message ?? lastErr}`);
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
