import { db } from "@workspace/db";
import { authorityDecisionsTable, creditLedgerTable, creditLedgerTxidsTable } from "@workspace/db/schema";
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
import { decisionIdFor, recordDecision } from "./authority";

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
/** #266: the named admission decision is absent, denied, or for other postings. */
export class LedgerAdmissionMissing extends Error {
  readonly code = "admission_missing";
  constructor(public decisionId: string) {
    super(`admission ${decisionId} is not a matching allow decision`);
  }
}
/** #266: the admission existed but its expiry passed before the ledger used it. */
export class LedgerAdmissionExpired extends Error {
  readonly code = "approval_expired";
  constructor(public decisionId: string) {
    super(`admission ${decisionId} expired before the ledger transaction ran`);
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
  /**
   * Who authorized this movement (#245). REQUIRED — a transaction with no
   * actor will not type-check, because an authority layer cannot make a
   * decision it cannot see the subject of. Recorded on the txids row, NOT in
   * the hashed tuple: adding it to computeEntryHash or canonicalPostingsHash
   * would invalidate every existing entry hash and turn every stored
   * idempotency record into a conflict. Per-transaction, not per-posting.
   * Conventions in use: `service:ledger-token:<principal>` (shared-secret
   * routes, provenance visible), `system:signup-grant`, or a bare
   * `kax:agent:<bot_id>` / `kax:user:<id>` principal (joinery purchases).
   */
  actor: string;
  /**
   * What kind of consequential action this is, for the authority decision
   * record (#248): credits.grant | credits.trade | credits.payout |
   * credits.escrow | commerce.purchase. Defaults to credits.move — an honest
   * "a movement happened" for callers that predate the vocabulary.
   */
  capability?: string;
  /**
   * #266: a decisionId from authorityPolicy.admit(). When present, the
   * transaction CONFIRMS it with one indexed read — a matching, unexpired
   * allow row for these exact postings — and links the txids row to it
   * instead of recording a fresh Phase 1a allow. Admission itself (policy
   * lookup, revocation, cap reservation) ran BEFORE this transaction opened;
   * nothing here re-does it. Absent, behavior is exactly Phase 1a.
   */
  admissionDecisionId?: string;
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

  // RULE SIX, enforced here and not at the routes.
  //
  // Every value store KAX holds settles through this function — the credit
  // endpoints, the signup grant, the Joinery till — so this is the one place a
  // freeze cannot be forgotten by the next thing that moves money. Putting the
  // check in `routes/ledger.ts` instead would have covered four routes and
  // missed the joinery sale, which is exactly the shape of the bug the gate
  // list in lib/revocation.ts exists to prevent.
  //
  // It runs BEFORE the idempotency lookup on purpose. A replay of a txId that
  // was posted while the agent was in good standing must not become a way to
  // touch a frozen account afterwards, even though it would apply nothing: the
  // honest answer to "may this account move" is no, and returning the original
  // receipt would say yes.
  const { assertAccountsNotFrozen } = await import("./frozenAccounts");
  await assertAccountsNotFrozen(input.postings.map((p) => p.account));

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

        // #266: confirm the admission. ONE indexed read (decision_id is
        // UNIQUE) — the only authority work permitted inside this
        // transaction; policy evaluation already happened in admit().
        if (input.admissionDecisionId) {
          const [adm] = await tx
            .select({
              decision: authorityDecisionsTable.decision,
              postingsHash: authorityDecisionsTable.postingsHash,
              expiresAt: authorityDecisionsTable.expiresAt,
            })
            .from(authorityDecisionsTable)
            .where(eq(authorityDecisionsTable.decisionId, input.admissionDecisionId))
            .limit(1);
          if (
            !adm ||
            adm.decision !== "allow" ||
            (adm.postingsHash != null && adm.postingsHash !== postingsHash)
          ) {
            throw new LedgerAdmissionMissing(input.admissionDecisionId);
          }
          if (adm.expiresAt != null && adm.expiresAt.getTime() <= Date.now()) {
            throw new LedgerAdmissionExpired(input.admissionDecisionId);
          }
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
        // #266: an admitted transaction links to the decision admit() already
        // recorded — writing a second allow row would fork the audit trail.
        // Un-admitted callers keep the Phase 1a record exactly as before.
        const decisionId = input.admissionDecisionId ?? decisionIdFor(input.txId);
        await tx.insert(creditLedgerTxidsTable).values({
          txId: input.txId,
          postingsHash,
          head: newHead,
          entryCount: rows.length,
          actor: input.actor,
          decisionId,
        });
        // #248: one immutable decision per consequential action, in the SAME
        // transaction — the postings, the txids row and the decision commit
        // or roll back together. Runs under the advisory lock; recordDecision
        // is a single INSERT with no reads, so it adds no serialization cost.
        // Phase 1a records "who caused this", never "was it permitted" —
        // permission is the topology rule's job.
        if (!input.admissionDecisionId) {
          await recordDecision(tx, {
            decisionId,
            actor: input.actor,
            capability: input.capability ?? "credits.move",
            asset: input.asset,
            decision: "allow",
            txId: input.txId,
            postingsHash,
          });
        }
        return { txId: input.txId, head: newHead, count: rows.length, idempotentReplay: false };
      });
    } catch (err) {
      // Business errors propagate as-is (the route maps them to 409).
      if (
        err instanceof LedgerInsufficientFunds ||
        err instanceof LedgerIdempotencyConflict ||
        err instanceof LedgerAdmissionMissing ||
        err instanceof LedgerAdmissionExpired
      )
        throw err;
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
export async function getTransaction(
  txId: string,
): Promise<{ txId: string; head: string; count: number; postingsHash: string; actor: string | null } | null> {
  const [rec] = await db
    .select()
    .from(creditLedgerTxidsTable)
    .where(eq(creditLedgerTxidsTable.txId, txId))
    .limit(1);
  return rec
    ? {
        txId: rec.txId,
        head: rec.head,
        count: rec.entryCount,
        postingsHash: rec.postingsHash,
        // Nullable in the READ shape: rows recorded before migration 0032
        // legitimately have no actor, and a backfilled guess would be a lie.
        actor: rec.actor ?? null,
      }
    : null;
}

/**
 * Total value that has left the house account for a given kind+asset since an
 * instant — i.e. the positive outflow (house debits are negative; we negate the
 * sum). Used to enforce a per-day mint cap on `/ledger/grant` so a compromised
 * mint token can't drain the house in one burst. Best-effort (a small race
 * window across concurrent grants is acceptable for play credits).
 *
 * This is a GLOBAL house-outflow cap and must not be extended for per-account
 * limits (#246): it has no account dimension, and its best-effort race window
 * is acceptable only because play credits are play. Per-account caps use
 * accountInflow / accountInflowTx below — the Tx variant exists precisely so
 * the read can run under postTransaction's advisory lock, where the race
 * window is zero.
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

// ---------------------------------------------------------------------------
// Per-account inflow (#246). Ships INERT: no route calls these yet. The
// primitive for locked decision #6's ~$100/day per-account purchase cap,
// landed before the on-ramp that will enforce it, so the cap arrives as a
// one-line comparison rather than a query someone writes under deadline.
// ---------------------------------------------------------------------------

/** The transaction handle db.transaction() hands its callback. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function inflowSum(
  executor: typeof db | DbTx,
  account: string,
  kind: string,
  asset: string,
  since: Date,
): Promise<bigint> {
  // One indexed read (credit_ledger_account_kind_created_idx, migration
  // 0033): positive postings only — an account's SPENDING must never offset
  // what has arrived, or a busy account could exceed the cap forever.
  const [row] = await executor
    .select({ s: sql<string>`COALESCE(SUM(${creditLedgerTable.amount}), 0)` })
    .from(creditLedgerTable)
    .where(
      and(
        eq(creditLedgerTable.account, account),
        eq(creditLedgerTable.asset, asset),
        eq(creditLedgerTable.kind, kind),
        sql`${creditLedgerTable.amount} > 0`,
        gte(creditLedgerTable.createdAt, since),
      ),
    );
  return BigInt(row?.s ?? "0");
}

/** Total value that has ARRIVED in an account for a kind+asset since an instant. */
export async function accountInflow(account: string, kind: string, asset: string, since: Date): Promise<bigint> {
  return inflowSum(db, account, kind, asset, since);
}

/**
 * Same, on an existing tx handle so it can run INSIDE postTransaction's
 * advisory lock — where no concurrent append can commit between this read and
 * the caller's insert, closing the race window houseOutflow tolerates. Single
 * round trip by construction.
 */
export async function accountInflowTx(
  tx: DbTx,
  account: string,
  kind: string,
  asset: string,
  since: Date,
): Promise<bigint> {
  return inflowSum(tx, account, kind, asset, since);
}

/** The rolling-window start: 24 hours before `now`. */
export function rollingDayStart(now: Date): Date {
  return new Date(now.getTime() - 24 * 3600 * 1000);
}

/** The 1st of `now`'s month, 00:00 UTC — calendar-month windows are UTC. */
export function calendarMonthStartUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
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
