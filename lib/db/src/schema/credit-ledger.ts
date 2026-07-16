import { pgTable, bigserial, bigint, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Double-entry, append-only, hash-chained credit ledger (ADR-0041 Phase 2).
 *
 * Each row is ONE posting. A transaction (`txId`) is a set of >= 2 postings
 * whose signed `amount`s sum to zero (double-entry) — value is only ever moved
 * between accounts, never created or destroyed except by an explicit
 * house/mint account that is itself part of the balanced set.
 *
 * Integrity:
 *  - **Balances are DERIVED** (`SUM(amount)` per account+asset), never stored
 *    and mutated. There is no balance column to get out of sync.
 *  - **Integer minor units** (`amount` is a bigint) — never floats for money.
 *  - **Hash chain**: each entry commits to the previous entry's hash
 *    (`prevHash`), so history can't be silently rewritten; `verifyChain`
 *    recomputes from the genesis sentinel.
 *  - **No forks**: `prevHash` is UNIQUE, so two entries can't both claim the
 *    same predecessor — a concurrent append that races loses the INSERT and
 *    retries against the new head (see lib/ledger.ts).
 *  - **Append-only**: a DB trigger (migration 0013) rejects UPDATE/DELETE, so
 *    immutability holds against any writer, not just the app code.
 *  - **Asset segregation**: play credits and (future) real money are different
 *    `asset` values and never fungible — a transaction may not mix assets.
 */
export const creditLedgerTable = pgTable(
  "credit_ledger",
  {
    // Monotonic chain order (also the surrogate key).
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    entryHash: text("entry_hash").notNull().unique(),
    prevHash: text("prev_hash").notNull(),
    // Groups the postings of one transaction; all postings in a txId sum to 0.
    txId: text("tx_id").notNull(),
    // e.g. "play_credit", later "usdc". Never mixed within a transaction.
    asset: text("asset").notNull(),
    // e.g. "user:<id>", "amm:<market>", "escrow:<market>", "house".
    account: text("account").notNull(),
    // Signed integer minor units. Debit negative, credit positive.
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    // Reason: "grant" | "trade" | "payout" | "stake" | "refund" | ...
    kind: text("kind").notNull(),
    // Reference to the thing that caused it (market id, prediction id, ...).
    ref: text("ref"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("credit_ledger_account_asset_idx").on(t.account, t.asset),
    index("credit_ledger_tx_idx").on(t.txId),
    // A fork (two entries pointing at the same predecessor) is impossible.
    uniqueIndex("credit_ledger_prev_hash_uq").on(t.prevHash),
  ],
);

export type CreditLedgerEntry = typeof creditLedgerTable.$inferSelect;
export type InsertCreditLedgerEntry = typeof creditLedgerTable.$inferInsert;
