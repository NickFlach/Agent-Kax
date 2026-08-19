import { CREDITS_PER_USDC, HOUSE_ACCOUNT, MINOR_UNITS_PER_USDC } from "./ledger-core";
import { accountInflow, postTransaction, rollingDayStart, type PostResult } from "./ledger";

/**
 * exchange.ts — the bank's EXCHANGE window (#181): money in, play_credit out.
 *
 * The design the issue recommends, taken whole:
 *   - PRIMARY RAIL: x402 (USDC, EIP-3009 gasless) — HTTP-402-native, which
 *     is why the settle endpoint answers 402 with an x402 `accepts` block
 *     until a payment rides in. AP2-compatible by construction.
 *   - ALT RAIL: L402/Lightning — the LNbits flow the MCP paid tier already
 *     runs; same mint, different verifier.
 *   - ONE-WAY ON-RAMP, the recommended posture: deposits mint, nothing
 *     redeems. This is structural, not policy — no withdraw function exists
 *     in this module, the router exposes no withdraw route (pinned by
 *     test), and the credit ledger's own topology has no kind that could
 *     pay a trader's balance back out to money.
 *
 * The peg is ledger-core's frozen CREDITS_PER_USDC (100 credits / 1 USDC)
 * — the same constant the commerce crossing uses, so no two doors disagree
 * about what a credit is worth.
 *
 * Deposits mint through the ONE permitted entry: a `grant` posting pair
 * (house → trader), via postTransaction — which also gives idempotency for
 * free: the txId is the rail's settlement id, so a replayed webhook or a
 * double-submitted header mints exactly once.
 *
 * OPERATOR DEPENDENCIES (the issue's open decisions, resolved or gated):
 *   - peg: decided by ledger-core (frozen constant).
 *   - one-way: decided here (recommended option), structural.
 *   - custody wallet: KAX_X402_PAY_TO — env, operator's address. Unset =
 *     the rail is down (503-when-unset idiom), never a silent default.
 *   - KYC/ToS: the per-account daily cap below is locked decision #6's
 *     ~$100/day, enforced with #246's accountInflow primitives.
 */

export class ExchangeUnconfigured extends Error {
  readonly code = "exchange_unconfigured";
  constructor(rail: string, envVar: string) {
    super(`the ${rail} exchange rail is not configured — set ${envVar}`);
  }
}

export class ExchangeRefused extends Error {
  constructor(message: string, readonly status: number, readonly codeName: string) {
    super(message);
  }
}

/** Locked decision #6: ~$100/day per account. In credits at the peg. */
export const DAILY_ACCOUNT_CAP_CREDITS = 100n * CREDITS_PER_USDC;

export const MIN_DEPOSIT_USDC_MINOR = 100_000n; // 0.10 USDC — below this, dust
export const MAX_DEPOSIT_USDC_MINOR = 100_000_000n; // 100 USDC — the daily cap in one move
const USDC_MINOR_PER_USDC = 1_000_000n;

export interface ExchangeQuote {
  creditsPerUsdc: string;
  minUsdcMinor: string;
  maxUsdcMinor: string;
  dailyAccountCapCredits: string;
  oneWay: true;
  rails: { x402: boolean; l402: boolean };
}

export function x402Configured(): boolean {
  return !!process.env["KAX_X402_PAY_TO"] && !!process.env["KAX_X402_FACILITATOR_URL"];
}
export function l402Configured(): boolean {
  return !!process.env["KAX_LNBITS_URL"] && !!process.env["KAX_LNBITS_API_KEY"];
}

export function exchangeQuote(): ExchangeQuote {
  return {
    creditsPerUsdc: CREDITS_PER_USDC.toString(),
    minUsdcMinor: MIN_DEPOSIT_USDC_MINOR.toString(),
    maxUsdcMinor: MAX_DEPOSIT_USDC_MINOR.toString(),
    dailyAccountCapCredits: DAILY_ACCOUNT_CAP_CREDITS.toString(),
    oneWay: true,
    rails: { x402: x402Configured(), l402: l402Configured() },
  };
}

/** The x402 challenge body a 402 response carries (x402Version 1, exact scheme). */
export function x402Challenge(resource: string, usdcMinor: bigint): Record<string, unknown> {
  const payTo = process.env["KAX_X402_PAY_TO"];
  if (!payTo) throw new ExchangeUnconfigured("x402", "KAX_X402_PAY_TO");
  return {
    x402Version: 1,
    error: "payment required",
    accepts: [
      {
        scheme: "exact",
        network: process.env["KAX_X402_NETWORK"] ?? "base",
        maxAmountRequired: usdcMinor.toString(),
        resource,
        description: `KAX play-credit exchange: ${usdcMinor} USDC minor units at ${CREDITS_PER_USDC} credits/USDC`,
        payTo,
        maxTimeoutSeconds: 300,
      },
    ],
  };
}

/**
 * What a rail's verifier must answer. Injectable: production x402 asks the
 * facilitator (KAX_X402_FACILITATOR_URL) to verify+settle the EIP-3009
 * authorization in the X-PAYMENT header; production L402 checks the
 * preimage against LNbits. Tests inject fakes — the mint logic is the same
 * either way, which is the point of the seam.
 */
export interface DepositVerification {
  ok: boolean;
  /** Rail-unique settlement id — becomes the mint's idempotent txId. */
  settlementId?: string;
  /** What actually settled, in USDC minor units. */
  usdcMinor?: bigint;
  reason?: string;
}
export type DepositVerifier = (opts: {
  paymentHeader: string;
  expectedUsdcMinor: bigint;
  payTo: string;
}) => Promise<DepositVerification>;

export interface SettleResult {
  credited: string; // credits, whole
  creditedMinor: string;
  txId: string;
  idempotentReplay: boolean;
}

/**
 * The one mint path both rails share. Verifies via the injected rail
 * verifier, enforces bounds and the per-account daily cap, then grants at
 * the frozen peg. Idempotent on the rail's settlement id.
 */
export async function settleDeposit(input: {
  rail: "x402" | "l402";
  principal: string;
  requestedUsdcMinor: bigint;
  paymentHeader: string;
  verifier: DepositVerifier;
  payTo: string;
}): Promise<SettleResult> {
  if (input.requestedUsdcMinor < MIN_DEPOSIT_USDC_MINOR) {
    throw new ExchangeRefused(`minimum deposit is ${MIN_DEPOSIT_USDC_MINOR} USDC minor units`, 400, "below_min");
  }
  if (input.requestedUsdcMinor > MAX_DEPOSIT_USDC_MINOR) {
    throw new ExchangeRefused(`maximum deposit is ${MAX_DEPOSIT_USDC_MINOR} USDC minor units`, 400, "above_max");
  }

  const trader = `trader:${input.principal}`;
  // Locked decision #6: the rolling-day per-account cap, measured over what
  // has ARRIVED as grants (#246's primitive — spending never offsets it).
  const arrived = await accountInflow(trader, "grant", "play_credit", rollingDayStart(new Date()));
  const capMinor = DAILY_ACCOUNT_CAP_CREDITS * (MINOR_UNITS_PER_USDC / CREDITS_PER_USDC);
  const wouldMintMinor = (input.requestedUsdcMinor * MINOR_UNITS_PER_USDC) / USDC_MINOR_PER_USDC;
  if (arrived + wouldMintMinor > capMinor) {
    throw new ExchangeRefused(
      `daily per-account exchange cap reached (${DAILY_ACCOUNT_CAP_CREDITS} credits/day)`,
      429,
      "daily_cap",
    );
  }

  const v = await input.verifier({
    paymentHeader: input.paymentHeader,
    expectedUsdcMinor: input.requestedUsdcMinor,
    payTo: input.payTo,
  });
  if (!v.ok || !v.settlementId || v.usdcMinor == null) {
    throw new ExchangeRefused(`payment did not verify: ${v.reason ?? "rejected"}`, 402, "payment_invalid");
  }
  if (v.usdcMinor !== input.requestedUsdcMinor) {
    throw new ExchangeRefused(
      `settled amount ${v.usdcMinor} differs from requested ${input.requestedUsdcMinor}`,
      402,
      "amount_mismatch",
    );
  }

  const mintedMinor = (v.usdcMinor * MINOR_UNITS_PER_USDC) / USDC_MINOR_PER_USDC;
  const txId = `exchange:${input.rail}:${v.settlementId}`;
  const ref = `exchange:${input.rail}`;
  const posted: PostResult = await postTransaction({
    txId,
    asset: "play_credit",
    postings: [
      { account: HOUSE_ACCOUNT, amount: -mintedMinor, kind: "grant", ref },
      { account: trader, amount: mintedMinor, kind: "grant", ref },
    ],
    actor: `service:exchange:${input.rail}:${input.principal}`,
    capability: "credits.grant",
  });
  return {
    credited: ((v.usdcMinor * CREDITS_PER_USDC) / USDC_MINOR_PER_USDC).toString(),
    creditedMinor: mintedMinor.toString(),
    txId,
    idempotentReplay: posted.idempotentReplay,
  };
}

/**
 * The production x402 verifier: POSTs the payment payload to the
 * facilitator's /settle. A facilitator that answers anything but a clean
 * settlement is a refusal — never a benefit of the doubt on money in.
 */
export function facilitatorVerifier(fetchImpl: typeof fetch = fetch): DepositVerifier {
  return async ({ paymentHeader, expectedUsdcMinor, payTo }) => {
    const base = process.env["KAX_X402_FACILITATOR_URL"];
    if (!base) throw new ExchangeUnconfigured("x402", "KAX_X402_FACILITATOR_URL");
    try {
      const res = await fetchImpl(`${base.replace(/\/$/, "")}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 1,
          paymentHeader,
          paymentRequirements: {
            scheme: "exact",
            network: process.env["KAX_X402_NETWORK"] ?? "base",
            maxAmountRequired: expectedUsdcMinor.toString(),
            payTo,
          },
        }),
      });
      if (!res.ok) return { ok: false, reason: `facilitator answered ${res.status}` };
      const body = (await res.json()) as { success?: boolean; transaction?: string; settlementId?: string; amount?: string };
      if (!body.success) return { ok: false, reason: "facilitator did not confirm settlement" };
      const id = body.settlementId ?? body.transaction;
      if (!id) return { ok: false, reason: "facilitator confirmed but returned no settlement id" };
      return { ok: true, settlementId: id, usdcMinor: body.amount ? BigInt(body.amount) : expectedUsdcMinor };
    } catch (e) {
      return { ok: false, reason: `facilitator unreachable: ${(e as Error).message}` };
    }
  };
}
