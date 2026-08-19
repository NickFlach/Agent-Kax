import { Router, type IRouter } from "express";
import { z } from "zod";
import { resolveActor, ActorError } from "../lib/actor";
import {
  ExchangeRefused,
  ExchangeUnconfigured,
  exchangeQuote,
  facilitatorVerifier,
  settleDeposit,
  x402Challenge,
  x402Configured,
  type DepositVerifier,
} from "../lib/exchange";

const router: IRouter = Router();

/**
 * The bank's EXCHANGE window (#181). GET quote is public; POST settle is
 * the x402 dance: no X-PAYMENT header answers 402 with the `accepts`
 * challenge, a header rides through the facilitator and mints at the peg.
 * The credited principal is the AUTHENTICATED caller's own — the body
 * never chooses who gets the credits.
 *
 * ONE-WAY: money comes in, credits go out, and nothing here runs the other
 * direction — the exchange test pins that absence at the source level.
 * Opening the reverse door is an ADR-sized decision, never a handler.
 */

router.get("/bank/exchange/quote", (_req, res) => {
  res.json(exchangeQuote());
});

const SettleBody = z.object({
  /** USDC minor units (6 dp) the caller intends to deposit. */
  usdcMinor: z.string().regex(/^[0-9]{1,12}$/),
});

/** Injectable for tests via app.locals.exchangeVerifier. */
function verifierFor(req: { app: { locals: Record<string, unknown> } }): DepositVerifier {
  const injected = req.app.locals["exchangeVerifier"];
  return typeof injected === "function" ? (injected as DepositVerifier) : facilitatorVerifier();
}

router.post("/bank/exchange/settle", async (req, res) => {
  const parsed = SettleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "usdcMinor: a decimal string of USDC minor units" });
    return;
  }
  const usdcMinor = BigInt(parsed.data.usdcMinor);

  try {
    if (!x402Configured()) {
      res.status(503).json({
        error: "the exchange window is not open (x402 rail unconfigured — set KAX_X402_PAY_TO and KAX_X402_FACILITATOR_URL)",
        code: "exchange_unconfigured",
      });
      return;
    }
    const actor = await resolveActor(req);
    if (!actor) {
      res.status(401).json({ error: "sign in, or send an agent identity token — credits land on YOUR account" });
      return;
    }

    const paymentHeader = req.headers["x-payment"];
    if (typeof paymentHeader !== "string" || paymentHeader === "") {
      // The x402-native answer: here is exactly what to pay, try again.
      res.status(402).json(x402Challenge("/api/bank/exchange/settle", usdcMinor));
      return;
    }

    const result = await settleDeposit({
      rail: "x402",
      principal: actor.principal,
      requestedUsdcMinor: usdcMinor,
      paymentHeader,
      verifier: verifierFor(req),
      payTo: process.env["KAX_X402_PAY_TO"]!,
    });
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  } catch (e) {
    if (e instanceof ExchangeUnconfigured) {
      res.status(503).json({ error: e.message, code: e.code });
      return;
    }
    if (e instanceof ExchangeRefused) {
      res.status(e.status).json({ error: e.message, code: e.codeName });
      return;
    }
    if (e instanceof ActorError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    throw e;
  }
});

export default router;
