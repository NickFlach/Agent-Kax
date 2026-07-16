import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { creditLedgerTable } from "@workspace/db/schema";
import { postTransaction, balance, verifyLedgerChain } from "./ledger";

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
});
