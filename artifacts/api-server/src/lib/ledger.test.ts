import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { creditLedgerTable } from "@workspace/db/schema";
import {
  postTransaction,
  balance,
  verifyLedgerChain,
  getTransaction,
  LedgerInsufficientFunds,
  LedgerIdempotencyConflict,
} from "./ledger";

// DB-backed (needs DATABASE_URL + migration 0013). Not run in CI (typecheck +
// build only); runs on Replit / any env with the DB. The ledger is append-only,
// so tests use unique account names per run rather than cleaning up.
const uniq = () => Math.random().toString(36).slice(2, 10);

describe("credit ledger (DB)", () => {
  it("posts a balanced transaction and derives balances", async () => {
    const asset = "play_credit";
    const house = `house:test:${uniq()}`;
    const user = `user:test:${uniq()}`;
    await postTransaction({
      txId: `grant-${uniq()}`,
      asset,
      postings: [
        { account: house, amount: -100n, kind: "grant" },
        { account: user, amount: 100n, kind: "grant" },
      ],
    });
    expect(await balance(user, asset)).toBe(100n);
    expect(await balance(house, asset)).toBe(-100n);
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
        { account: `x:${uniq()}`, amount: -5n, kind: "grant" },
        { account: `y:${uniq()}`, amount: 5n, kind: "grant" },
      ],
    });
    const res = await verifyLedgerChain();
    expect(res.ok).toBe(true);
  });

  it("rejects UPDATE/DELETE (append-only trigger)", async () => {
    // Any mutation of the ledger must be refused at the DB level.
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
