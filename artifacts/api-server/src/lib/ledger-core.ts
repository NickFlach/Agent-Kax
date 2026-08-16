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

// ---------------------------------------------------------------------------
// The peg. Issue #181 decision 3 locks these numbers: they are set once and
// never changed, because every balance ever recorded is denominated in them and
// there is no migration that can reinterpret history. Changing any of the three
// is a governance decision, not a refactor — nothing else in the codebase may
// restate the scale as its own literal.
// ---------------------------------------------------------------------------

/** 1 play_credit = 1,000,000 ledger minor units. Frozen — see issue #181 decision 3. */
export const MINOR_UNITS_PER_CREDIT = 1_000_000n;
/** 1 USDC = 100 play_credit. Frozen — see issue #181 decision 3. */
export const CREDITS_PER_USDC = 100n;
/** 1 USDC = 100,000,000 ledger minor units. */
export const MINOR_UNITS_PER_USDC = MINOR_UNITS_PER_CREDIT * CREDITS_PER_USDC;

/** Basis-point denominator, for the fee ceiling below. */
const BPS = 10_000n;

/**
 * The most of a debited trader's money that may reach the house in one
 * transaction, in basis points.
 *
 * A fee is a fee because of its RATE. The joinery's house cut is
 * joinery-core's HOUSE_BPS of the price and can never be more, so a
 * transaction that takes a trader's money and hands the house a larger share
 * than this is not collecting a fee whatever its kind says — it is a
 * redemption with a fee's paperwork. This lives here rather than in
 * joinery-core because it bounds every kind at once, and because ledger-core
 * may not import from a module that imports it.
 */
export const MAX_HOUSE_FEE_BPS = 1000n;

// How many fractional digits a credit has, derived from the scale rather than
// written down a second time, so the two can never drift apart.
const CREDIT_DECIMALS = MINOR_UNITS_PER_CREDIT.toString().length - 1;

/** Convert a whole number of play_credit into ledger minor units. */
export function creditsToMinor(credits: bigint): bigint {
  return credits * MINOR_UNITS_PER_CREDIT;
}

/**
 * Render minor units as an exact decimal credit string.
 *
 * Deliberately bigint-only: dividing by 1e6 in floating point silently loses
 * precision once a balance passes 2^53 minor units (a little over 9 billion
 * credits), and a ledger that misreports a balance it holds correctly is worse
 * than one that refuses to display it. Trailing zeros are trimmed, so a whole
 * number of credits prints without a fractional part at all.
 */
export function minorToCreditsString(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / MINOR_UNITS_PER_CREDIT;
  const frac = abs % MINOR_UNITS_PER_CREDIT;
  const sign = negative ? "-" : "";
  if (frac === 0n) return `${sign}${whole.toString()}`;
  const digits = frac.toString().padStart(CREDIT_DECIMALS, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}.${digits}`;
}

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

// ---------------------------------------------------------------------------
// Permitted posting topology. Issue #181 decisions 4 (no cash-out) and 5 (no
// P2P transfers) held until now only by the ABSENCE of an endpoint that would
// break them, and absence is not an invariant: anything that ever gains the
// ability to call postTransaction inherits the ability to redeem credits for
// house value or to move a balance sideways between two agents, and no test
// would notice. The table below is the complete set of movements this codebase
// actually performs, so a new economic power has to arrive as an edit here
// rather than as a posting nobody reviewed.
// ---------------------------------------------------------------------------

/** The account classes the ledger recognises. Everything else is `unknown`. */
export type AccountClass = "house" | "trader" | "amm" | "unknown";

const TRADER_PREFIX = "trader:";
const AMM_PREFIX = "amm:";

/**
 * Classify an account string. These prefixes are the grammar routes/ledger.ts
 * builds every account from, so an account outside them was not built by the
 * server — which is also why a typo must be refused rather than accepted: an
 * accepted one becomes a permanent balance no principal can ever spend from,
 * and nothing would ever report it.
 */
export function accountClass(account: string): AccountClass {
  if (account === HOUSE_ACCOUNT) return "house";
  if (account.startsWith(TRADER_PREFIX) && account.length > TRADER_PREFIX.length) return "trader";
  if (account.startsWith(AMM_PREFIX) && account.length > AMM_PREFIX.length) return "amm";
  return "unknown";
}

interface KindTopology {
  readonly debits: ReadonlySet<AccountClass>;
  readonly credits: ReadonlySet<AccountClass>;
  /** Both sides at once, for a zero posting, which is neither. */
  readonly either: ReadonlySet<AccountClass>;
}

function topology(debits: AccountClass[], credits: AccountClass[]): KindTopology {
  return {
    debits: new Set(debits),
    credits: new Set(credits),
    either: new Set([...debits, ...credits]),
  };
}

/**
 * Which account classes each posting kind may debit and credit. This is the
 * complete permitted set: a kind absent from it is refused outright, so a
 * posting named `transfer` never lands.
 *
 * That is a statement about the NAME, not about the shape, and the difference
 * matters. Two of these kinds — `trade` and `joinery` — have a trader on both
 * sides of the table, so a per-posting rule cannot by itself tell a sale from
 * a sideways move between two agents. `joinery` genuinely cannot be told
 * apart, because a piece cheap enough for the house cut to round away IS a
 * bare trader-to-trader posting and is legitimate. `trade` can be, and is,
 * below: the pool has to actually be one of the two parties.
 */
const PERMITTED_TOPOLOGY: ReadonlyMap<string, KindTopology> = new Map<string, KindTopology>([
  // The mint. Credits enter circulation from the house and from nowhere else.
  ["grant", topology(["house"], ["trader"])],
  // The LMSR subsidy that backs a market before anyone trades in it.
  ["escrow", topology(["house"], ["amm"])],
  // A trade is a trader and a pool exchanging value; `side` decides which way,
  // which is why both classes sit on both sides here. The whole-transaction
  // rule below is what says a pool must be one of them.
  ["trade", topology(["trader", "amm"], ["trader", "amm"])],
  // Resolution draws the pool down to its winners and sweeps whatever subsidy
  // is left back to the house as the residual.
  ["payout", topology(["amm"], ["trader", "house"])],
  // A joinery sale moves the price from the buyer to the seller...
  ["joinery", topology(["trader"], ["trader"])],
  // ...and these two legs are paid out of that same price, never on their own.
  ["joinery_fee", topology([], ["house"])],
  ["joinery_royalty", topology([], ["trader"])],
]);

/**
 * Enforce the permitted topology, plus the structural refusals that no
 * per-kind table can state on its own because they are properties of the whole
 * transaction rather than of any one posting: two for decision 4 (a house leg
 * with nobody else paid, and a house leg too large to be a fee) and one for
 * decision 5 (a `trade` with no pool in it).
 */
function assertPermittedTopology(postings: Posting[]): void {
  let traderDebit: Posting | null = null;
  let houseCredited = false;
  let traderCredited = false;
  let traderDebitTotal = 0n;
  let houseCreditTotal = 0n;
  const tradeDebitClasses = new Set<AccountClass>();
  const tradeCreditClasses = new Set<AccountClass>();

  for (const p of postings) {
    const cls = accountClass(p.account);
    if (cls === "unknown") {
      throw new Error(
        `kind '${p.kind}' names account '${p.account}', which parses to account class 'unknown'; ` +
          `permitted classes are 'house', 'trader:<principal>' and 'amm:<market>'`,
      );
    }
    const rule = PERMITTED_TOPOLOGY.get(p.kind);
    if (!rule) {
      throw new Error(`kind '${p.kind}' is not a permitted posting kind (account class '${cls}')`);
    }
    const side = p.amount < 0n ? "debit" : p.amount > 0n ? "credit" : "post to";
    const allowed = p.amount < 0n ? rule.debits : p.amount > 0n ? rule.credits : rule.either;
    if (!allowed.has(cls)) {
      throw new Error(`kind '${p.kind}' may not ${side} account class '${cls}' (${p.account})`);
    }
    if (cls === "trader") {
      if (p.amount < 0n) {
        traderDebit = p;
        traderDebitTotal -= p.amount;
      }
      if (p.amount > 0n) traderCredited = true;
    }
    if (cls === "house" && p.amount > 0n) {
      houseCredited = true;
      houseCreditTotal += p.amount;
    }
    if (p.kind === "trade") {
      if (p.amount < 0n) tradeDebitClasses.add(cls);
      if (p.amount > 0n) tradeCreditClasses.add(cls);
    }
  }

  // No redemption (decision 4). A trader paying the house is a sale taking its
  // fee ONLY when the same transaction also pays a trader; with nobody on the
  // receiving side the identical shape is a cash-out, and this ledger does not
  // do cash-outs. The test is whether house is CREDITED, not whether house is
  // present: lib/joinery.ts drops zero postings, so a piece cheap enough for
  // the fee to round to zero produces a legitimate trader-to-trader sale with
  // no house leg at all, and keying on presence would refuse it.
  if (traderDebit && houseCredited && !traderCredited) {
    throw new Error(
      `no redemption: kind '${traderDebit.kind}' debits account class 'trader' (${traderDebit.account}) ` +
        `and credits account class 'house' without crediting any trader`,
    );
  }

  // The rule above asks only whether SOME trader was credited, and the debited
  // trader itself counts, so a token kickback defeats it:
  // [trader:x -100, trader:x +1, house +99] pays a trader and moves 99 to the
  // house, which is a redemption with one unit of paperwork. Asking who was
  // credited cannot close that — any threshold on the kickback is a number an
  // attacker picks. What actually separates a fee from a cash-out is its RATE,
  // so bound the house's take against the money taken from traders. Keyed on a
  // trader being debited, because the residual sweep at the end of a market
  // credits the house out of a POOL and is not a fee at all.
  if (traderDebitTotal > 0n && houseCreditTotal * BPS > traderDebitTotal * MAX_HOUSE_FEE_BPS) {
    throw new Error(
      `no redemption: ${houseCreditTotal} to account class 'house' out of ${traderDebitTotal} debited from ` +
        `account class 'trader' exceeds the ${MAX_HOUSE_FEE_BPS}bps a fee may take`,
    );
  }

  // No P2P transfers (decision 5), for the one kind where the shape can be
  // told apart. `trade` has trader and amm on both sides of the table because
  // either may be the debited party, and taken alone that permits two traders
  // moving a balance between them under a market's name. /ledger/trade always
  // pairs a trader with a pool, so require the two sides to be different
  // classes — which, given the table, means one of them is the pool. Stated as
  // sets rather than as "exactly two postings" so a future batched trade
  // against one pool is not refused for the wrong reason.
  if (tradeDebitClasses.size > 0 || tradeCreditClasses.size > 0) {
    const debited = [...tradeDebitClasses];
    const credited = [...tradeCreditClasses];
    if (debited.length !== 1 || credited.length !== 1 || debited[0] === credited[0]) {
      throw new Error(
        `kind 'trade' must exchange value between a trader and a market pool; got debits ` +
          `[${debited.join(", ")}] and credits [${credited.join(", ")}]`,
      );
    }
  }
}

/**
 * Validate one transaction's postings: at least two, all integer bigints, a
 * single asset, signed amounts summing to exactly zero — the double-entry
 * invariant — and a permitted account-class topology for every kind. Throws on
 * any violation. Value is only moved, never conjured (an explicit house/mint
 * account must be one of the balanced postings), and it may only move along
 * the routes the city actually has.
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
  assertPermittedTopology(postings);
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
