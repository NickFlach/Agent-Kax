import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { creditLedgerTable } from "@workspace/db/schema";
import { HOUSE_ACCOUNT } from "./ledger-core";
import { splitSale } from "./joinery-core";
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
//
// Every account below is `house`, `trader:…` or `amm:…` because since #244
// those are the only classes the ledger recognises. The placeholder names this
// file used before (`user:…`, `a:…`, `sink:…`) are now refused, and correctly
// so: an account outside the grammar is one no principal can ever spend from.
const uniq = () => Math.random().toString(36).slice(2, 10);

describe("credit ledger (DB)", () => {
  it("posts a balanced transaction and derives balances", async () => {
    const asset = "play_credit";
    const user = `trader:test:${uniq()}`;
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
          { account: HOUSE_ACCOUNT, amount: -100n, kind: "grant" },
          { account: `trader:test:${uniq()}`, amount: 99n, kind: "grant" },
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
        { account: `trader:test:${uniq()}`, amount: 5n, kind: "grant" },
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
        { account: `trader:test:${uniq()}`, amount: 1n, kind: "grant" },
      ],
    });
    // drizzle wraps driver errors, replacing the message with "Failed query:
    // ...", so the trigger's own RAISE text ("credit_ledger is append-only: %
    // is not permitted") lands on `.cause`. Asserting on the top-level message
    // would fail even though the trigger fired correctly — so check both that
    // it rejects AND that the rejection is genuinely the append-only guard
    // rather than any other query error.
    const err = await db
      .execute(sql`UPDATE credit_ledger SET amount = amount WHERE seq = (SELECT MIN(seq) FROM credit_ledger)`)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err, "the append-only trigger did not reject the UPDATE").not.toBe(null);
    const cause = (err as { cause?: { message?: string } })?.cause;
    expect(`${cause?.message ?? ""}${(err as Error)?.message ?? ""}`).toMatch(/append-only/);
  });

  it("is idempotent: a replayed txId applies nothing and returns the original", async () => {
    const asset = "play_credit";
    const house = `house`; // house is exempt from the overdraft guard
    const user = `trader:test:${uniq()}`;
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
      postings: [{ account: "house", amount: -5n, kind: "grant" }, { account: `trader:test:${uniq()}`, amount: 5n, kind: "grant" }],
    });
    await expect(
      postTransaction({
        txId, asset,
        postings: [{ account: "house", amount: -6n, kind: "grant" }, { account: `trader:test:${uniq()}`, amount: 6n, kind: "grant" }],
      }),
    ).rejects.toBeInstanceOf(LedgerIdempotencyConflict);
  });

  it("blocks an overdraft: a debit that would take a non-house account negative", async () => {
    const asset = "play_credit";
    const user = `trader:test:${uniq()}`;
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

// ---------------------------------------------------------------------------
// Permitted posting topology at the DB boundary (issue #244).
//
// ledger-core.test.ts covers the rule itself against every shape. What these
// add is that postTransaction refuses BEFORE anything is written: a wrongly
// refused post is a 400, but a wrongly ACCEPTED one is a balance that exists
// forever, so each refusal here also asserts the balances did not move.
// ---------------------------------------------------------------------------

describe("credit ledger topology (DB)", () => {
  const asset = "play_credit";

  /** A funded trader, granted from the house exactly as signup does. */
  async function fundedTrader(amount: bigint): Promise<string> {
    const account = `trader:test:${uniq()}`;
    await postTransaction({
      txId: `topo-fund-${uniq()}`,
      asset,
      postings: [
        { account: HOUSE_ACCOUNT, amount: -amount, kind: "grant" },
        { account, amount, kind: "grant" },
      ],
    });
    return account;
  }

  it("refuses a redemption and writes nothing", async () => {
    const trader = await fundedTrader(100n);
    await expect(
      postTransaction({
        txId: `redeem-${uniq()}`,
        asset,
        postings: [
          { account: trader, amount: -100n, kind: "redeem" },
          { account: HOUSE_ACCOUNT, amount: 100n, kind: "redeem" },
        ],
      }),
    ).rejects.toThrow(/not a permitted posting kind/);
    expect(await balance(trader, asset)).toBe(100n);
  });

  it("refuses a cash-out dressed in a joinery sale's kinds", async () => {
    // Both kinds are permitted and both classes sit on a side the table allows.
    // Only the no-redemption rule refuses this, so if that rule were dropped
    // this test would be the one that noticed.
    const trader = await fundedTrader(100n);
    await expect(
      postTransaction({
        txId: `fee-cashout-${uniq()}`,
        asset,
        postings: [
          { account: trader, amount: -100n, kind: "joinery", ref: "joinery sale: listing 1" },
          { account: HOUSE_ACCOUNT, amount: 100n, kind: "joinery_fee", ref: "joinery sale: listing 1" },
        ],
      }),
    ).rejects.toThrow(/no redemption/);
    expect(await balance(trader, asset)).toBe(100n);
  });

  it("refuses a P2P transfer between two traders", async () => {
    const from = await fundedTrader(100n);
    const to = `trader:test:${uniq()}`;
    await expect(
      postTransaction({
        txId: `transfer-${uniq()}`,
        asset,
        postings: [
          { account: from, amount: -100n, kind: "transfer" },
          { account: to, amount: 100n, kind: "transfer" },
        ],
      }),
    ).rejects.toThrow(/kind 'transfer' is not a permitted posting kind/);
    expect(await balance(from, asset)).toBe(100n);
    expect(await balance(to, asset)).toBe(0n);
  });

  it("refuses a P2P transfer that calls itself a trade", async () => {
    // The test above only proves the WORD `transfer` is refused, which is the
    // easy half. `trade` is a permitted kind with a trader on both sides of
    // its row, so this is the same movement under a name the ledger accepts —
    // and the one a caller reaching for a sideways move would actually pick.
    const from = await fundedTrader(100n);
    const to = `trader:test:${uniq()}`;
    await expect(
      postTransaction({
        txId: `sideways-${uniq()}`,
        asset,
        postings: [
          { account: from, amount: -100n, kind: "trade" },
          { account: to, amount: 100n, kind: "trade" },
        ],
      }),
    ).rejects.toThrow(/kind 'trade' must exchange value between a trader and a market pool/);
    expect(await balance(from, asset)).toBe(100n);
    expect(await balance(to, asset)).toBe(0n);
  });

  it("refuses an account outside the known classes", async () => {
    // Per-run, like every other account here, and for a sharper reason than
    // tidiness: the one failure this test exists to catch is the guard being
    // gone, and a fixed name would then take a permanent 100n balance on an
    // append-only ledger that has no delete. The assertion below would fail
    // forever afterwards — against CI's database and against the developer's —
    // turning a diagnosis into damage.
    const stranger = `merchant:${uniq()}`;
    await expect(
      postTransaction({
        txId: `merchant-${uniq()}`,
        asset,
        postings: [
          { account: HOUSE_ACCOUNT, amount: -100n, kind: "grant" },
          { account: stranger, amount: 100n, kind: "grant" },
        ],
      }),
    ).rejects.toThrow(/'unknown'/);
    expect(await balance(stranger, asset)).toBe(0n);
  });

  it("permits a joinery sale whose house fee rounds away to nothing", async () => {
    // The shape lib/joinery.ts posts for a very cheap piece: the fee leg is 0
    // and gets filtered, leaving two traders and no house posting at all.
    const split = splitSale(9n, true);
    expect(split.house, "pick a price whose house cut actually rounds to zero").toBe(0n);

    const buyer = await fundedTrader(split.price);
    const seller = `trader:test:${uniq()}`;
    const ref = "joinery sale: listing 1";
    const postings = [
      { account: buyer, amount: -split.price, kind: "joinery", ref },
      { account: seller, amount: split.seller, kind: "joinery", ref },
      { account: HOUSE_ACCOUNT, amount: split.house, kind: "joinery_fee", ref },
    ].filter((p) => p.amount !== 0n);
    expect(postings).toHaveLength(2);

    await postTransaction({ txId: `cheap-sale-${uniq()}`, asset, postings });
    expect(await balance(buyer, asset)).toBe(0n);
    expect(await balance(seller, asset)).toBe(split.seller);
  });

  it("permits the residual-only payout sweep with no winners", async () => {
    const pool = `amm:test${uniq()}`;
    await postTransaction({
      txId: `escrow-${uniq()}`,
      asset,
      postings: [
        { account: HOUSE_ACCOUNT, amount: -1000n, kind: "escrow" },
        { account: pool, amount: 1000n, kind: "escrow" },
      ],
    });
    // Nobody held the winning side, so the whole pool goes back to the house.
    await postTransaction({
      txId: `sweep-${uniq()}`,
      asset,
      postings: [
        { account: pool, amount: -1000n, kind: "payout" },
        { account: HOUSE_ACCOUNT, amount: 1000n, kind: "payout" },
      ],
    });
    expect(await balance(pool, asset)).toBe(0n);
  });
});
