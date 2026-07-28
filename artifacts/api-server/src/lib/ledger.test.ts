import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { creditLedgerTable } from "@workspace/db/schema";
import { HOUSE_ACCOUNT } from "./ledger-core";
import {
  postTransaction,
  balance,
  verifyLedgerChain,
  getTransaction,
  LedgerInsufficientFunds,
  LedgerIdempotencyConflict,
} from "./ledger";

// DB-backed (needs DATABASE_URL + migration 0013). Runs in CI since #126 gave
// the workflow a real Postgres built from the captured baseline. The ledger is
// append-only, so tests use unique account names per run rather than cleaning
// up.
//
// The funding side of every grant must be HOUSE_ACCOUNT. The overdraft guard
// exempts exactly that account (`p.account !== HOUSE_ACCOUNT`, an exact match,
// not a `house:` prefix), so any other account debited from zero is correctly
// rejected as insufficient funds — which is what production does too: the
// signup grant in routes/identity.ts posts from HOUSE_ACCOUNT. These tests
// previously funded from `house:test:<random>` and only ever passed against a
// long-lived database where those accounts happened to carry a balance.
const uniq = () => Math.random().toString(36).slice(2, 10);

describe("credit ledger (DB)", () => {
  it("posts a balanced transaction and derives balances", async () => {
    const asset = "play_credit";
    const user = `user:test:${uniq()}`;
    // Shared, so measure the delta rather than an absolute balance.
    const houseBefore = await balance(HOUSE_ACCOUNT, asset);
    await postTransaction({
      txId: `grant-${uniq()}`,
      asset,
      postings: [
        { account: HOUSE_ACCOUNT, amount: -100n, kind: "grant" },
        { account: user, amount: 100n, kind: "grant" },
      ],
    });
    expect(await balance(user, asset)).toBe(100n);
    expect(await balance(HOUSE_ACCOUNT, asset)).toBe(houseBefore - 100n);
    // A second posting reduces the user's derived balance.
    await postTransaction({
      txId: `spend-${uniq()}`,
      asset,
      postings: [
        { account: user, amount: -30n, kind: "trade" },
        { account: `amm:test:${uniq()}`, amount: 30n, kind: "trade" },
      ],
    });
    expect(await balance(user, asset)).toBe(70n);
  });

  it("rejects an unbalanced transaction (double-entry)", async () => {
    await expect(
      postTransaction({
        txId: `bad-${uniq()}`,
        asset: "play_credit",
        postings: [
          { account: `a:${uniq()}`, amount: -100n, kind: "grant" },
          { account: `b:${uniq()}`, amount: 99n, kind: "grant" },
        ],
      }),
    ).rejects.toThrow(/sum to zero/);
  });

  it("keeps a verifiable hash chain", async () => {
    await postTransaction({
      txId: `chain-${uniq()}`,
      asset: "play_credit",
      postings: [
        { account: HOUSE_ACCOUNT, amount: -5n, kind: "grant" },
        { account: `y:${uniq()}`, amount: 5n, kind: "grant" },
      ],
    });
    const res = await verifyLedgerChain();
    expect(res.ok).toBe(true);
  });

  it("rejects UPDATE/DELETE (append-only trigger)", async () => {
    // Any mutation of the ledger must be refused at the DB level.
    //
    // Post first so the table is guaranteed non-empty: the trigger is BEFORE
    // UPDATE FOR EACH ROW, so against an empty ledger `MIN(seq)` is NULL, the
    // UPDATE matches zero rows, and the statement resolves without the trigger
    // ever firing — the assertion would pass for the wrong reason on a fresh
    // database, and fail as "resolved instead of rejecting" here.
    await postTransaction({
      txId: `trigger-${uniq()}`,
      asset: "play_credit",
      postings: [
        { account: HOUSE_ACCOUNT, amount: -1n, kind: "grant" },
        { account: `sink:${uniq()}`, amount: 1n, kind: "grant" },
      ],
    });
    await expect(
      db.execute(sql`UPDATE credit_ledger SET amount = amount WHERE seq = (SELECT MIN(seq) FROM credit_ledger)`),
    ).rejects.toThrow(/append-only/);
  });

  it("is idempotent: a replayed txId applies nothing and returns the original", async () => {
    const asset = "play_credit";
    const house = `house`; // house is exempt from the overdraft guard
    const user = `user:test:${uniq()}`;
    const txId = `grant-${uniq()}`;
    const postings = [
      { account: house, amount: -100n, kind: "grant" as const },
      { account: user, amount: 100n, kind: "grant" as const },
    ];
    const first = await postTransaction({ txId, asset, postings });
    expect(first.idempotentReplay).toBe(false);
    // Replay the SAME txId + postings — must be a no-op returning the original.
    const replay = await postTransaction({ txId, asset, postings });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.head).toBe(first.head);
    // Balance applied exactly once, not twice.
    expect(await balance(user, asset)).toBe(100n);
    // getTransaction sees it.
    expect((await getTransaction(txId))?.head).toBe(first.head);
  });

  it("rejects a replayed txId carrying DIFFERENT postings", async () => {
    const asset = "play_credit";
    const txId = `conflict-${uniq()}`;
    await postTransaction({
      txId, asset,
      postings: [{ account: "house", amount: -5n, kind: "grant" }, { account: `u:${uniq()}`, amount: 5n, kind: "grant" }],
    });
    await expect(
      postTransaction({
        txId, asset,
        postings: [{ account: "house", amount: -6n, kind: "grant" }, { account: `u:${uniq()}`, amount: 6n, kind: "grant" }],
      }),
    ).rejects.toBeInstanceOf(LedgerIdempotencyConflict);
  });

  it("blocks an overdraft: a debit that would take a non-house account negative", async () => {
    const asset = "play_credit";
    const user = `user:test:${uniq()}`;
    await postTransaction({
      txId: `seed-${uniq()}`, asset,
      postings: [{ account: "house", amount: -50n, kind: "grant" }, { account: user, amount: 50n, kind: "grant" }],
    });
    // Spending 80 from a 50 balance must be rejected — no credits minted.
    await expect(
      postTransaction({
        txId: `over-${uniq()}`, asset,
        postings: [{ account: user, amount: -80n, kind: "trade" }, { account: `amm:${uniq()}`, amount: 80n, kind: "trade" }],
      }),
    ).rejects.toBeInstanceOf(LedgerInsufficientFunds);
    expect(await balance(user, asset)).toBe(50n); // unchanged
  });
});
