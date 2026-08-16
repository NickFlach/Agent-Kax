/**
 * ledger.test.ts — the HTTP surface that moves value (#251).
 *
 * lib/ledger.test.ts covers the library. Nothing covered the routes, and the
 * gap is not cosmetic: the fail-closed behaviour of requireLedgerMintToken /
 * requireLedgerTradeToken was asserted nowhere at all. Those two middlewares
 * are the only thing standing between an unconfigured deployment and a mint.
 *
 * The failure they prevent is the quiet kind. A gate that falls OPEN when its
 * variable is unset looks identical to a gate that is working, on every
 * deployment where the variable happens to be set — which is every deployment
 * anybody tests. It is wrong exactly once, on the one that forgot, and that is
 * the one where credits can be minted by anybody who finds the endpoint.
 *
 * So the tests below spend most of their attention on absence: no token, wrong
 * token, and the neighbouring tokens that must NOT be accepted as substitutes.
 *
 * Env is mutated per-test and restored in afterEach, because the middleware
 * reads process.env at request time rather than at import time — which is what
 * makes it testable without a rebuild, and what makes a leaked variable able to
 * corrupt every later case in the file.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import pino from "pino";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { creditLedgerTable } from "@workspace/db/schema";
import ledgerRouter from "./ledger";
import { balance } from "../lib/ledger";
import { HOUSE_ACCOUNT } from "../lib/ledger-core";

const MINT = "test-mint-token-9f3a";
const TRADE = "test-trade-token-7b21";
const ASSET = "play_credit";

/** Every env var these routes read, so each case starts from a known state. */
const LEDGER_VARS = [
  "KAX_LEDGER_MINT_TOKEN",
  "KAX_LEDGER_TRADE_TOKEN",
  "KAX_LEDGER_GRANT_DAILY_CAP",
  "KAX_SERVICE_TOKEN",
  "FLOOR_LEDGER_TOKEN",
] as const;

const saved: Record<string, string | undefined> = {};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  const testLog = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = testLog;
    next();
  });
  app.use(ledgerRouter);
  return app;
}

const app = buildApp();
const uniq = () => Math.random().toString(36).slice(2, 10);
const txIds: string[] = [];

/** A tx id this file can find again, so nothing it wrote is left behind. */
function tx(label: string): string {
  const id = `test-ledger-http-${label}-${uniq()}`;
  txIds.push(id);
  return id;
}

describe("ledger HTTP surface", () => {
  beforeEach(() => {
    for (const k of LEDGER_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of LEDGER_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  afterAll(async () => {
    // The ledger is append-only by trigger, so rows written here cannot be
    // UPDATEd — but they can be deleted, and leaving them would drift every
    // later balance assertion in the suite that runs after this one.
    for (const id of txIds) {
      await db.delete(creditLedgerTable).where(eq(creditLedgerTable.txId, id)).catch(() => undefined);
    }
  });

  describe("fails closed when unconfigured", () => {
    it("refuses to mint when KAX_LEDGER_MINT_TOKEN is unset", async () => {
      // The whole point. An unset variable must disable the surface, not open
      // it — and it must say WHICH variable, because the operator reading this
      // 503 is the person who can fix it.
      for (const path of ["/ledger/grant", "/ledger/escrow"]) {
        const res = await request(app).post(path).send({ txId: tx("closed"), asset: ASSET, amount: "100" });
        expect(res.status, `${path} did not fail closed`).toBe(503);
        expect(res.body.error).toMatch(/KAX_LEDGER_MINT_TOKEN unset/);
      }
    });

    it("refuses to trade when KAX_LEDGER_TRADE_TOKEN is unset", async () => {
      for (const path of ["/ledger/trade", "/ledger/payout"]) {
        const res = await request(app).post(path).send({ txId: tx("closed"), asset: ASSET, amount: "100" });
        expect(res.status, `${path} did not fail closed`).toBe(503);
        expect(res.body.error).toMatch(/KAX_LEDGER_TRADE_TOKEN unset/);
      }
    });

    it("accepts no neighbouring token as a substitute", async () => {
      // A gate that quietly honours the service token is a gate with a second
      // key nobody documented. Both are set here and the ledger vars are not.
      process.env["KAX_SERVICE_TOKEN"] = "service-token-value";
      process.env["FLOOR_LEDGER_TOKEN"] = "floor-token-value";

      for (const [path, token] of [
        ["/ledger/grant", "service-token-value"],
        ["/ledger/grant", "floor-token-value"],
        ["/ledger/trade", "service-token-value"],
        ["/ledger/trade", "floor-token-value"],
      ] as const) {
        const res = await request(app)
          .post(path)
          .set("Authorization", `Bearer ${token}`)
          .send({ txId: tx("substitute"), asset: ASSET, amount: "100" });
        expect(res.status, `${path} accepted a substitute token`).toBe(503);
      }
    });

    it("does not leak whether a token would have been right", async () => {
      // 503 before 401: when the surface is disabled the answer must not vary
      // with what the caller presented, or the endpoint becomes an oracle for
      // guessing the token it is about to start accepting.
      const withToken = await request(app)
        .post("/ledger/grant")
        .set("Authorization", "Bearer anything-at-all")
        .send({ txId: tx("oracle"), asset: ASSET, amount: "100" });
      const without = await request(app)
        .post("/ledger/grant")
        .send({ txId: tx("oracle"), asset: ASSET, amount: "100" });
      expect(withToken.status).toBe(503);
      expect(without.status).toBe(503);
      expect(withToken.body.error).toBe(without.body.error);
    });
  });

  describe("with the mint surface configured", () => {
    beforeEach(() => {
      process.env["KAX_LEDGER_MINT_TOKEN"] = MINT;
    });

    it("rejects a wrong token with 401, not 503", async () => {
      const res = await request(app)
        .post("/ledger/grant")
        .set("Authorization", "Bearer wrong")
        .send({ txId: tx("wrong"), asset: ASSET, amount: "100" });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid or missing/i);
    });

    it("grants, and replaying the same txId moves nothing more", async () => {
      const principal = `kax:agent:${uniq()}`;
      const account = `trader:${principal}`;
      const txId = tx("grant");
      const houseBefore = await balance(HOUSE_ACCOUNT, ASSET);

      const first = await request(app)
        .post("/ledger/grant")
        .set("Authorization", `Bearer ${MINT}`)
        .send({ txId, asset: ASSET, principal, amount: "500", ref: "test grant" });
      expect(first.status).toBe(201);
      expect(await balance(account, ASSET)).toBe(500n);
      expect(await balance(HOUSE_ACCOUNT, ASSET)).toBe(houseBefore - 500n);

      // Idempotency is what makes a retry safe on a value-moving endpoint.
      const replay = await request(app)
        .post("/ledger/grant")
        .set("Authorization", `Bearer ${MINT}`)
        .send({ txId, asset: ASSET, principal, amount: "500", ref: "test grant" });
      expect(replay.status).toBe(200);
      expect(await balance(account, ASSET), "a replay minted a second time").toBe(500n);
    });

    it("refuses a principal outside the account grammar", async () => {
      // An account outside the grammar is one no principal can ever spend
      // from, so credits sent there are burned with no error to say so.
      for (const principal of ["", "ab", "has spaces", "!!!", "x".repeat(200)]) {
        const res = await request(app)
          .post("/ledger/grant")
          .set("Authorization", `Bearer ${MINT}`)
          .send({ txId: tx("grammar"), asset: ASSET, principal, amount: "100" });
        expect(res.status, `principal ${JSON.stringify(principal)} was accepted`).toBe(400);
      }
    });

    it("refuses an amount that is not a positive integer", async () => {
      for (const amount of ["0", "-5", "1.5", "abc", ""]) {
        const res = await request(app)
          .post("/ledger/grant")
          .set("Authorization", `Bearer ${MINT}`)
          .send({ txId: tx("amount"), asset: ASSET, principal: `kax:agent:${uniq()}`, amount });
        expect(res.status, `amount ${JSON.stringify(amount)} was accepted`).toBe(400);
      }
    });

    it("stops minting once the daily cap is reached", async () => {
      // The cap bounds a compromised mint token's blast radius. It is measured
      // against house outflow since UTC midnight, so this asserts the refusal
      // rather than an exact remaining figure.
      process.env["KAX_LEDGER_GRANT_DAILY_CAP"] = "1";
      const res = await request(app)
        .post("/ledger/grant")
        .set("Authorization", `Bearer ${MINT}`)
        .send({ txId: tx("cap"), asset: ASSET, principal: `kax:agent:${uniq()}`, amount: "1000" });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("grant_cap");
      expect(res.body.cap).toBe("1");
    });

    it("treats an unparseable cap as no cap, rather than as zero", async () => {
      // `cap > 0n` is the live condition; a garbage value must not silently
      // disable granting, which would look exactly like an outage.
      process.env["KAX_LEDGER_GRANT_DAILY_CAP"] = "not-a-number";
      const res = await request(app)
        .post("/ledger/grant")
        .set("Authorization", `Bearer ${MINT}`)
        .send({ txId: tx("badcap"), asset: ASSET, principal: `kax:agent:${uniq()}`, amount: "10" });
      expect(res.status).toBe(201);
    });
  });

  describe("with the trade surface configured", () => {
    beforeEach(() => {
      process.env["KAX_LEDGER_MINT_TOKEN"] = MINT;
      process.env["KAX_LEDGER_TRADE_TOKEN"] = TRADE;
    });

    it("will not let a trader spend more than they hold", async () => {
      // The overdraft guard is what bounds this surface: value moves between
      // non-house accounts and is never minted here, so a trader going
      // negative would be credits created by a route that cannot create them.
      const principal = `kax:agent:${uniq()}`;
      const marketId = `mkt-${uniq()}`;
      await request(app)
        .post("/ledger/grant")
        .set("Authorization", `Bearer ${MINT}`)
        .send({ txId: tx("fund"), asset: ASSET, principal, amount: "50" });

      const res = await request(app)
        .post("/ledger/trade")
        .set("Authorization", `Bearer ${TRADE}`)
        .send({ txId: tx("overdraft"), asset: ASSET, principal, marketId, amount: "80", side: "buy" });

      expect([402, 409]).toContain(res.status);
      expect(await balance(`trader:${principal}`, ASSET), "an overdraft moved value").toBe(50n);
    });

    it("rejects a wrong trade token with 401", async () => {
      const res = await request(app)
        .post("/ledger/trade")
        .set("Authorization", `Bearer ${MINT}`) // the MINT token, on the TRADE surface
        .send({ txId: tx("crosstoken"), asset: ASSET, principal: `kax:agent:${uniq()}`, marketId: `mkt-${uniq()}`, amount: "10" });
      expect(res.status, "the mint token was accepted on the trade surface").toBe(401);
    });
  });
});
