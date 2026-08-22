import crypto from "node:crypto";
import { db } from "@workspace/db";
import { commerceLedgerTable, commerceLedgerTxidsTable } from "@workspace/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { creditsToMinor, HOUSE_ACCOUNT } from "./ledger-core";
import { postTransaction } from "./ledger";

/**
 * commerceLedger.ts — the fiat ledger's core (#265, v0.2, DARK).
 *
 * A SEPARATE ledger from credit_ledger, structurally: its own chain, its own
 * advisory lock key, its own account grammar, integer USD cents. The play
 * ledger's ALLOWED_ASSETS is untouched, and the two meet at exactly ONE
 * one-way crossing (electCreatorShareAsCredits below).
 *
 * OPERATOR GATE: the account grammar below awaits accountant review before
 * real money runs through it (#265's operator dependency). The ledger is
 * dark — nothing posts to it — precisely so the review can happen against a
 * fixed shape rather than a moving one.
 */

/** Serializes ALL commerce-ledger appends. NOT the credit ledger's key. */
const COMMERCE_LEDGER_ADVISORY_KEY = 0xc0313d6e;

export const COMMERCE_LEDGER_GENESIS = "GENESIS::commerce-ledger::v1";

/**
 * The account grammar. Every account is one of:
 *   customer                 — the paying card's side of a charge
 *   merchant:<id>            — a commerce_merchants row's fiat position
 *   kax_platform             — KAX's own take
 *   processor:<name>         — e.g. processor:stripe (fees, payouts in transit)
 *   pod:<provider>           — e.g. pod:printify (fulfilment cost)
 *   tax_liability:<juris>    — collected-not-yet-remitted; a credit-balance
 *                              account, fine HERE because this is not
 *                              credit_ledger, whose overdraft guard exempts
 *                              only the exact string "house".
 */
const ACCOUNT_RE =
  /^(customer|kax_platform|merchant:[1-9]\d*|processor:[a-z0-9_-]+|pod:[a-z0-9_-]+|tax_liability:[A-Za-z0-9_.-]+)$/;

export function isCommerceLedgerAccount(a: string): boolean {
  return ACCOUNT_RE.test(a);
}

/** Primary movements plus the explicit reversal vocabulary from the issue. */
export const COMMERCE_LEDGER_KINDS = [
  "charge",
  "processor_fee",
  "platform_fee",
  "fulfillment_cost",
  "creator_share",
  "payout",
  "refund",
  "partial_refund",
  "chargeback",
  "chargeback_reversal",
  "tax_collected",
  "tax_adjustment",
  "reprint_cost",
] as const;
export type CommerceLedgerKind = (typeof COMMERCE_LEDGER_KINDS)[number];

export interface CommercePosting {
  account: string;
  /** Signed integer cents. Debit negative, credit positive. */
  amountCents: bigint;
  kind: CommerceLedgerKind;
  ref?: string | null;
}

export function validateCommercePostings(postings: CommercePosting[], currency: string): void {
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new Error("a commerce transaction needs at least two postings (double-entry)");
  }
  if (!/^[a-z]{3}$/.test(currency)) throw new Error(`currency must be a lowercase ISO code; got '${currency}'`);
  let sum = 0n;
  for (const p of postings) {
    if (typeof p.amountCents !== "bigint") throw new Error("amountCents must be a bigint of integer cents");
    if (!isCommerceLedgerAccount(p.account)) {
      throw new Error(`'${p.account}' is not a commerce-ledger account (grammar in commerceLedger.ts)`);
    }
    if (!(COMMERCE_LEDGER_KINDS as readonly string[]).includes(p.kind)) {
      throw new Error(`'${p.kind}' is not a commerce-ledger kind`);
    }
    sum += p.amountCents;
  }
  if (sum !== 0n) throw new Error(`postings must sum to zero (double-entry); got ${sum.toString()}`);
}

function canonical(prevHash: string, e: { txId: string; currency: string; account: string; amountCents: bigint; kind: string; ref?: string | null }): string {
  return JSON.stringify([prevHash, e.txId, e.currency, e.account, e.amountCents.toString(), e.kind, e.ref ?? null]);
}
function entryHash(prevHash: string, e: Parameters<typeof canonical>[1]): string {
  return crypto.createHash("sha256").update(canonical(prevHash, e)).digest("hex");
}
export function commercePostingsHash(txId: string, currency: string, postings: CommercePosting[]): string {
  const body = JSON.stringify([txId, currency, postings.map((p) => [p.account, p.amountCents.toString(), p.kind, p.ref ?? null])]);
  return crypto.createHash("sha256").update(body).digest("hex");
}

export interface CommercePostInput {
  txId: string;
  currency: string;
  postings: CommercePosting[];
  /** #245's rule holds here too: no movement without a named authorizer. */
  actor: string;
}

export interface CommercePostResult {
  txId: string;
  head: string;
  count: number;
  idempotentReplay: boolean;
}

/** Append one balanced fiat transaction. Same discipline as postTransaction. */
export async function postCommerceTransaction(input: CommercePostInput): Promise<CommercePostResult> {
  validateCommercePostings(input.postings, input.currency);
  const postingsHash = commercePostingsHash(input.txId, input.currency, input.postings);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${COMMERCE_LEDGER_ADVISORY_KEY})`);
    const [rec] = await tx
      .select()
      .from(commerceLedgerTxidsTable)
      .where(eq(commerceLedgerTxidsTable.txId, input.txId))
      .limit(1);
    if (rec) {
      if (rec.postingsHash !== postingsHash) {
        throw new Error(`commerce txId ${input.txId} already recorded with DIFFERENT postings`);
      }
      return { txId: input.txId, head: rec.head, count: rec.entryCount, idempotentReplay: true };
    }
    const [head] = await tx
      .select({ entryHash: commerceLedgerTable.entryHash })
      .from(commerceLedgerTable)
      .orderBy(desc(commerceLedgerTable.seq))
      .limit(1);
    let prev = head ? head.entryHash : COMMERCE_LEDGER_GENESIS;
    const rows = input.postings.map((p) => {
      const e = { txId: input.txId, currency: input.currency, account: p.account, amountCents: p.amountCents, kind: p.kind, ref: p.ref ?? null };
      const h = entryHash(prev, e);
      const row = { ...e, prevHash: prev, entryHash: h };
      prev = h;
      return row;
    });
    await tx.insert(commerceLedgerTable).values(rows);
    await tx.insert(commerceLedgerTxidsTable).values({
      txId: input.txId,
      postingsHash,
      head: prev,
      entryCount: rows.length,
      actor: input.actor,
    });
    return { txId: input.txId, head: prev, count: rows.length, idempotentReplay: false };
  });
}

/** Sum an account's fiat position. */
export async function commerceBalance(account: string, currency: string): Promise<bigint> {
  const [row] = await db
    .select({ s: sql<string>`COALESCE(SUM(${commerceLedgerTable.amountCents}), 0)` })
    .from(commerceLedgerTable)
    .where(sql`${commerceLedgerTable.account} = ${account} AND ${commerceLedgerTable.currency} = ${currency}`);
  return BigInt(row?.s ?? "0");
}

// ---------------------------------------------------------------------------
// The ONE permitted crossing, one-way by construction (#265).
// ---------------------------------------------------------------------------

/**
 * A creator electing their fiat share as play credits. Posts a house→trader
 * GRANT on the credit ledger at the frozen peg — 1 USD cent = 1 play_credit
 * (1 USDC = 100 credits, ledger-core's CREDITS_PER_USDC) — carrying a ref to
 * the commerce order, and a matching commerce-ledger movement that retires
 * the merchant's fiat claim into kax_platform (KAX keeps the dollars; the
 * creator took credits instead).
 *
 * ONE-WAY is structural, not policed: no function converts credits to fiat,
 * the commerce grammar has no account credits could arrive FROM, and the
 * credit ledger's topology rule already refuses redemption at every policy
 * version. The reverse path does not exist to be forbidden.
 */
export async function electCreatorShareAsCredits(input: {
  merchantId: number;
  creatorPrincipal: string;
  shareCents: bigint;
  commerceOrderRef: string;
  actor: string;
}): Promise<{ creditTxId: string; commerceTxId: string }> {
  if (input.shareCents <= 0n) throw new Error("shareCents must be positive");
  const commerceTxId = `elect:${input.commerceOrderRef}:${input.merchantId}`;
  await postCommerceTransaction({
    txId: commerceTxId,
    currency: "usd",
    postings: [
      { account: `merchant:${input.merchantId}`, amountCents: -input.shareCents, kind: "creator_share", ref: input.commerceOrderRef },
      { account: "kax_platform", amountCents: input.shareCents, kind: "creator_share", ref: input.commerceOrderRef },
    ],
    actor: input.actor,
  });
  // 1 cent = 1 credit at the frozen peg; creditsToMinor carries it to minor units.
  const credits = input.shareCents;
  const creditTxId = `grant:elect:${input.commerceOrderRef}:${input.merchantId}`;
  await postTransaction({
    txId: creditTxId,
    asset: "play_credit",
    postings: [
      { account: HOUSE_ACCOUNT, amount: -creditsToMinor(credits), kind: "grant", ref: `commerce:${input.commerceOrderRef}` },
      { account: `trader:${input.creatorPrincipal}`, amount: creditsToMinor(credits), kind: "grant", ref: `commerce:${input.commerceOrderRef}` },
    ],
    actor: input.actor,
    capability: "credits.grant",
  });
  return { creditTxId, commerceTxId };
}

/**
 * Pay the agent's royalty at settlement (#414), the split NAMED in the consent
 * record. Reads the consent (royaltyShareCents) and routes the share through
 * the SAME creator-share path the rest of commerce uses
 * (electCreatorShareAsCredits): the fiat side stays merchant → kax_platform,
 * and the agent — who holds no bank account — receives its share as play
 * credits. Returns null when there is no active consent, so a mis-sequenced
 * caller pays nothing on work that was never consented to.
 *
 * This lives in the settlement layer, NOT reachable from commerce.ts's route
 * graph, which is why it may reach the ledger while the consent RECORD
 * (artifactConsent.ts, imported by the routes) stays ledger-free.
 */
export async function settleConsentRoyalty(input: {
  artifactId: number;
  channel: "physical" | "occ_gallery" | "drop";
  saleTotalCents: bigint;
  merchantId: number;
  creatorPrincipal: string;
  commerceOrderRef: string;
  actor: string;
}): Promise<{ shareCents: bigint; creditTxId: string; commerceTxId: string } | null> {
  const { getConsent, royaltyShareCents } = await import("./artifactConsent");
  const consent = await getConsent(input.artifactId, input.channel);
  const shareCents = royaltyShareCents(consent, input.saleTotalCents);
  if (shareCents <= 0n) return null;
  const r = await electCreatorShareAsCredits({
    merchantId: input.merchantId,
    creatorPrincipal: input.creatorPrincipal,
    shareCents,
    commerceOrderRef: input.commerceOrderRef,
    actor: input.actor,
  });
  return { shareCents, ...r };
}
