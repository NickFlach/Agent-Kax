/**
 * me-purchasing.test.ts — `purchasing` has to survive the response schema, and
 * the address behind it has to stay behind it.
 *
 * The first half is a re-run of the trap recorded at `routes/auth.ts`: task #52
 * added `walletAddress` to the OpenAPI schema, the handler never supplied it,
 * and `GetCurrentAuthUserResponse.parse()` STRIPPED it silently — no error, no
 * warning, a contract that said the field existed and a response that did not
 * have it. A field added to `/me` in the same way, in the same file, through
 * the same parse call, fails the same way. So the assertions here are on the
 * KEYS of the response body, which an `undefined`-versus-missing check would
 * not catch.
 *
 * The second half is the shipping address. `user_shipping_addresses` is the
 * first postal PII in this schema, and `/me` is the first endpoint that reads
 * it. What is allowed out is a country and a postal code; the recipient's name,
 * the street lines and the city are not, and the case below fails if any of
 * them ever appears in the body.
 *
 * Runs against CI's real Postgres, through the real authMiddleware — the
 * session cookie is what decides `authenticated`, so faking it would remove the
 * only input the `anonymous` case is about.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { db } from "@workspace/db";
import {
  userPaymentMethodsTable,
  userPurchasingConsentsTable,
  userShippingAddressesTable,
} from "@workspace/db/schema";
import authRouter from "./auth";
import storeCheckoutRouter from "./store-checkout";
import { authMiddleware } from "../middlewares/authMiddleware";
import { CURRENT_STORED_CARD_TERMS_VERSION } from "../lib/purchasingState";
import { cleanupAuthTestData, createWalletUser } from "../test-helpers";

/**
 * The flag is the only environment this suite touches, and it is put back
 * exactly as found — the runner is single-fork, so a leaked value would decide
 * which branch a later file exercises.
 */
let priorFlag: string | undefined;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(authRouter);
  // Mounted so the "nothing else is on sale" case has something real to 404.
  // Without it that assertion would pass against an empty router and prove
  // nothing about the gate.
  app.use(storeCheckoutRouter);
  return app;
}

/** The street-level fields that must never leave the server. */
const ADDRESS_SECRETS = {
  name: "Test Buyer",
  line1: "1 Test Way",
  line2: "Apt 4",
  city: "Portland",
  region: "OR",
  postalCode: "97201",
  country: "US",
  phone: "+15035550100",
} as const;

describe("GET /me — derived purchasing state (#283)", () => {
  let app: Express;
  const userIds: string[] = [];
  const sids: string[] = [];

  beforeEach(() => {
    app = buildApp();
    priorFlag = process.env["KAX_COMMERCE_ENABLED"];
    delete process.env["KAX_COMMERCE_ENABLED"];
  });

  afterEach(async () => {
    if (priorFlag === undefined) delete process.env["KAX_COMMERCE_ENABLED"];
    else process.env["KAX_COMMERCE_ENABLED"] = priorFlag;
    await cleanupAuthTestData({ userIds: userIds.splice(0), sids: sids.splice(0) });
  });

  async function signedInUser(): Promise<{ id: string; cookie: string }> {
    const { id, sid } = await createWalletUser();
    userIds.push(id);
    sids.push(sid);
    return { id, cookie: `sid=${sid}` };
  }

  async function configureAccount(
    userId: string,
    opts: { termsVersion?: string; country?: string } = {},
  ): Promise<void> {
    await db.insert(userShippingAddressesTable).values({
      userId,
      ...ADDRESS_SECRETS,
      country: opts.country ?? ADDRESS_SECRETS.country,
    });
    await db.insert(userPaymentMethodsTable).values({
      userId,
      stripePaymentMethodId: `pm_test_${userId}`,
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2035,
      isDefault: true,
    });
    await db.insert(userPurchasingConsentsTable).values({
      userId,
      termsVersion: opts.termsVersion ?? CURRENT_STORED_CARD_TERMS_VERSION,
      termsSha256: "0".repeat(64),
    });
  }

  describe("with KAX_COMMERCE_ENABLED unset", () => {
    it("reports disabled rather than omitting the field", async () => {
      const { cookie } = await signedInUser();
      const res = await request(app).get("/me").set("Cookie", cookie);

      expect(res.status).toBe(200);
      // The #52 regression shape: the key has to be THERE. A stripped field
      // reads as `undefined`, which `toBe("disabled")` would also fail on, but
      // only this assertion says why.
      expect(Object.keys(res.body)).toContain("purchasing");
      expect(res.body.purchasing.state).toBe("disabled");
      expect(res.body.purchasing.reasons).toEqual(["disabled"]);
    });

    it("reports disabled to an anonymous caller too", async () => {
      const res = await request(app).get("/me");
      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
      expect(res.body.purchasing.state).toBe("disabled");
    });

    it("describes a fully configured account as disabled, and names no card", async () => {
      // The account is complete. With the surface off, none of it comes out —
      // a "disabled" that still returned the card and the postal code would
      // leak both from a deployment that deliberately switched commerce off.
      const { id, cookie } = await signedInUser();
      await configureAccount(id);

      const res = await request(app).get("/me").set("Cookie", cookie);
      expect(res.body.purchasing.state).toBe("disabled");
      expect(res.body.purchasing.card).toBeNull();
      expect(res.body.purchasing.shipsTo).toBeNull();
    });

    it("leaves the rest of the commerce surface unreachable", async () => {
      // The epic's other endpoints do not exist on this branch, and the ones
      // that do are gated. 404, not 401: with the flag off the route answers as
      // if it were never registered. Remove the gate in store-checkout.ts and
      // this becomes a 401 from requireAuth.
      const res = await request(app).post("/store/listings/1/checkout").send({});
      expect(res.status).toBe(404);
    });
  });

  describe("with KAX_COMMERCE_ENABLED on", () => {
    beforeEach(() => {
      process.env["KAX_COMMERCE_ENABLED"] = "1";
    });

    it("reports anonymous for a caller with no session", async () => {
      const res = await request(app).get("/me");
      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
      expect(res.body.purchasing.state).toBe("anonymous");
    });

    it("reports not_configured for an account with nothing on file", async () => {
      const { cookie } = await signedInUser();
      const res = await request(app).get("/me").set("Cookie", cookie);

      expect(res.body.user).toBeTruthy();
      expect(res.body.purchasing.state).toBe("not_configured");
      // The account has never accepted the terms either, and the panel needs
      // both halves or it sends the buyer round the loop twice.
      expect(res.body.purchasing.reasons).toContain("consent_stale");
      expect(res.body.purchasing.consentVersion).toBeNull();
    });

    it("reports ready once an address, a card and a current consent exist", async () => {
      const { id, cookie } = await signedInUser();
      await configureAccount(id);

      const res = await request(app).get("/me").set("Cookie", cookie);
      expect(res.body.purchasing.state).toBe("ready");
      expect(res.body.purchasing.reasons).toEqual([]);
      expect(res.body.purchasing.card).toMatchObject({ brand: "visa", last4: "4242" });
      expect(res.body.purchasing.consentVersion).toBe(CURRENT_STORED_CARD_TERMS_VERSION);
    });

    it("goes stale when the accepted terms are not the current ones", async () => {
      // Derived, not stored: nothing about this account changed. The version it
      // is compared against did.
      const { id, cookie } = await signedInUser();
      await configureAccount(id, { termsVersion: "v0-superseded" });

      const res = await request(app).get("/me").set("Cookie", cookie);
      expect(res.body.purchasing.state).toBe("consent_stale");
      expect(res.body.purchasing.consentVersion).toBe("v0-superseded");
    });

    it("returns the country and postal code and nothing else about the address", async () => {
      const { id, cookie } = await signedInUser();
      await configureAccount(id);

      const res = await request(app).get("/me").set("Cookie", cookie);
      expect(res.body.purchasing.shipsTo).toEqual({ country: "US", postalCode: "97201" });

      // The guard, stated over the whole serialised body rather than over the
      // one field: widening `shipsTo`, or attaching the address anywhere else
      // in the response, fails here.
      const body = JSON.stringify(res.body);
      for (const secret of [
        ADDRESS_SECRETS.name,
        ADDRESS_SECRETS.line1,
        ADDRESS_SECRETS.line2,
        ADDRESS_SECRETS.city,
        ADDRESS_SECRETS.phone,
      ]) {
        expect(body, `${secret} must not leave the server`).not.toContain(secret);
      }
    });

    it("refuses a destination it cannot ship to without asking for the address again", async () => {
      const { id, cookie } = await signedInUser();
      await configureAccount(id, { country: "GB" });

      const res = await request(app).get("/me").set("Cookie", cookie);
      expect(res.body.purchasing.state).toBe("unsupported_destination");
      expect(res.body.purchasing.reasons).not.toContain("needs_address");
    });

    it("keeps every purchasing key through the response schema", async () => {
      // The parse call is shared with `/auth/user`, and a nested object is
      // exactly as strippable as a scalar. Naming each key individually is what
      // catches a partial strip — `card: null` and no `card` at all both read
      // as falsy.
      const { cookie } = await signedInUser();
      const res = await request(app).get("/me").set("Cookie", cookie);
      expect(Object.keys(res.body.purchasing).sort()).toEqual([
        "card",
        "consentVersion",
        "reasons",
        "shipsTo",
        "state",
      ]);
    });

    it("still reports the user fields it always did", async () => {
      // The over-correction guard: adding `purchasing` to the parsed object
      // must not have moved anything else out of it.
      const { cookie } = await signedInUser();
      const res = await request(app).get("/auth/user").set("Cookie", cookie);
      expect(Object.keys(res.body.user)).toContain("walletAddress");
      expect(Object.keys(res.body.user)).toContain("provider");
      expect(res.body.purchasing.state).toBe("not_configured");
    });
  });
});
