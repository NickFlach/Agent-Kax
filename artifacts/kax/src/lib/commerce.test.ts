/**
 * commerce.test.ts — the decisions the purchase panel makes, called directly.
 *
 * Four of them can go wrong in a way that costs money or wedges a buyer, and
 * none of them fails a typecheck.
 *
 * **The idempotency key.** `shouldReuseReference` is the whole protection
 * against a lost response charging a card twice, and it is also the whole
 * protection against the opposite failure — a retry under a spent reference
 * that reports the same decline or the same expired quote forever. It is
 * therefore tested from both sides, status by status, rather than by asserting
 * "retries work".
 *
 * **The refusal vocabulary.** `routes/commerce.ts` declares nine refusals and
 * can also answer with any of the twelve purchasing states. A word the panel
 * has no entry for is a buyer looking at a dead end with no button on it, and
 * nothing anywhere reports that. Both lists are read out of the server as
 * source and compared, the technique `purchasing.test.ts` uses for the same
 * class of drift.
 *
 * **The outcome table.** An unrecognised purchase outcome must poll and must
 * never be called settled: telling a buyer their order is done when the server
 * has not said so is the one wrong answer available here.
 *
 * **The URLs.** A path that does not match a route is a 404 the client turns
 * into "nothing physical here" — a silent, total loss of the surface. The
 * strings are compared against the routes actually declared on the server.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_STATE_RECOURSE,
  CommerceError,
  REFUSAL_ADVICE,
  fetchPhysicalOrders,
  fetchPhysicalProducts,
  formatMoney,
  isSuccessfulOutcome,
  mergeOrders,
  refusalAdvice,
  shouldReuseReference,
  showsFulfillment,
  stepFor,
  submitPurchase,
  type DigitalOrder,
  type PhysicalOrder,
} from "./commerce";
import { PURCHASING_STATE_COPY } from "./purchasing";

const here = dirname(fileURLToPath(import.meta.url));
const API_SERVER = join(here, "..", "..", "..", "api-server", "src");

function readServer(...parts: string[]): string {
  return readFileSync(join(API_SERVER, ...parts), "utf8").replace(/\r\n/g, "\n");
}

const COMMERCE_ROUTE_SOURCE = readServer("routes", "commerce.ts");
const CLIENT_SOURCE = readFileSync(join(here, "commerce.ts"), "utf8").replace(/\r\n/g, "\n");

/** Every word `CommerceRefusal` declares, i.e. every `reason` this surface sends. */
function serverRefusals(): string[] {
  const start = COMMERCE_ROUTE_SOURCE.indexOf("export type CommerceRefusal =");
  if (start < 0) throw new Error("CommerceRefusal is no longer declared the way this test reads it");
  // The terminator is `";` — a closing quote immediately followed by the
  // semicolon — and NOT a bare `;`. One of the doc comments inside the union
  // contains "Re-quote; never charge a stale total", and stopping at that
  // semicolon would silently read five of the nine members. The length
  // assertion below is what would catch this happening again.
  const end = COMMERCE_ROUTE_SOURCE.indexOf('";', start);
  if (end < 0) throw new Error("CommerceRefusal is no longer terminated the way this test reads it");
  return [...COMMERCE_ROUTE_SOURCE.slice(start, end + 1).matchAll(/\|\s*"([a-z_]+)"/g)].map(
    (m) => m[1]!,
  );
}

/** Every path `routes/commerce.ts` actually mounts. */
function serverRoutes(): string[] {
  return [...COMMERCE_ROUTE_SOURCE.matchAll(/router\.(?:get|post)\("(\/commerce[^"]*)"/g)].map(
    (m) => m[1]!,
  );
}

describe("the refusal vocabulary", () => {
  it("has advice for every way the server refuses", () => {
    // The direction that leaves a buyer stuck: a tenth refusal on the server
    // and nothing here renders the server's raw sentence with no button under
    // it, and the buyer has no idea whether to wait, retry or go to settings.
    const missing = serverRefusals().filter((r) => !(r in REFUSAL_ADVICE));
    expect(missing, "server refusals with no advice on the panel").toEqual([]);
  });

  it("does not carry advice for refusals the server cannot send", () => {
    const server = serverRefusals();
    const orphans = Object.keys(REFUSAL_ADVICE).filter((r) => !server.includes(r));
    expect(orphans, "advice for refusals nothing can send").toEqual([]);
  });

  it("reads all nine refusals out of the route, not an empty list", () => {
    // Guards the guards. If the parser stopped matching, both tests above would
    // pass against nothing at all.
    expect(serverRefusals()).toHaveLength(9);
    expect(serverRefusals()).toContain("card_declined");
    expect(serverRefusals()).toContain("quote_expired");
  });

  it("has a recourse for every purchasing state a purchase can be refused with", () => {
    // `requireReady` answers 409 with `reason: snapshot.state`, so all twelve
    // arrive here as refusals. A state with no entry falls through to the
    // generic branch and offers "try again" against an account that will refuse
    // in exactly the same way every time.
    const states = Object.keys(PURCHASING_STATE_COPY);
    expect(states).toHaveLength(12);
    const missing = states.filter((s) => !(s in ACCOUNT_STATE_RECOURSE));
    expect(missing, "purchasing states with no recourse").toEqual([]);
  });

  it("does not send a buyer to settings for a state settings cannot fix", () => {
    // `cap_reached` clears with the clock and there is nothing in the panel to
    // change; `disabled` is a property of the deployment. A settings link on
    // either is a loop the buyer walks twice before giving up.
    expect(ACCOUNT_STATE_RECOURSE["cap_reached"]).toBe("none");
    expect(ACCOUNT_STATE_RECOURSE["disabled"]).toBe("none");
    // And the ones that ARE fixable still say so, so the assertion above is not
    // passing because everything is "none".
    expect(ACCOUNT_STATE_RECOURSE["needs_address"]).toBe("settings");
    expect(ACCOUNT_STATE_RECOURSE["card_expired"]).toBe("settings");
  });
});

describe("what a refusal tells the buyer", () => {
  function refusal(status: number, reason: string, message = "Refused"): CommerceError {
    return new CommerceError(message, { status, reason });
  }

  it("routes a stale quote to a new price, not to settings", () => {
    // Sending a buyer to their card settings over a five-minute-old price is
    // the wrong door, and they come back to the same refusal.
    expect(refusalAdvice(refusal(410, "quote_expired")).recourse).toBe("requote");
    expect(refusalAdvice(refusal(409, "price_changed")).recourse).toBe("requote");
  });

  it("routes a declined card to settings", () => {
    expect(refusalAdvice(refusal(402, "card_declined")).recourse).toBe("settings");
  });

  it("speaks the purchasing desk's own words for an account-state refusal", () => {
    // The twelve states already have copy that tracks the server's list. A
    // second wording here would drift from the settings card the buyer is about
    // to be sent to, and they would read two different accounts of one problem.
    const advice = refusalAdvice(refusal(409, "needs_address"));
    expect(advice.message).toBe(PURCHASING_STATE_COPY["needs_address"]!.detail);
    expect(advice.recourse).toBe("settings");
  });

  it("falls back to the server's own sentence for a reason it has never seen", () => {
    // A newer server against a cached bundle. The message is written for a
    // human and carries nothing about the buyer, so showing it is better than
    // showing "something went wrong".
    const advice = refusalAdvice(refusal(409, "some_refusal_from_the_future", "We can't do that"));
    expect(advice.message).toBe("We can't do that");
  });

  it("offers a retry when the request never got an answer", () => {
    const advice = refusalAdvice(new CommerceError("Failed to fetch", { status: null }));
    expect(advice.recourse).toBe("retry");
  });
});

describe("the idempotency key", () => {
  it("survives a request that got no answer at all", () => {
    // THE case the whole protocol exists for. The order row may already be
    // written and the card may already be charged, with only the response lost.
    // A fresh reference here is a second purchase of the same thing.
    expect(shouldReuseReference(new CommerceError("Failed to fetch", { status: null }))).toBe(true);
  });

  it("survives a 5xx", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(shouldReuseReference(new CommerceError("boom", { status })), String(status)).toBe(true);
    }
  });

  it("survives a failure that is not a CommerceError at all", () => {
    // An unexpected throw between the send and the parse tells us nothing about
    // whether the charge landed, and the safe assumption is that it did.
    expect(shouldReuseReference(new TypeError("undefined is not a function"))).toBe(true);
  });

  it("is discarded after an expired quote, or every retry 410s forever", () => {
    // The trap. On a retry the server finds the earlier UNPAID row under this
    // reference, judges it older than the quote TTL and refuses — and that row
    // does not age backwards. Reusing the reference reproduces the same 410 for
    // as long as the buyer keeps pressing.
    expect(shouldReuseReference(new CommerceError("expired", { status: 410, reason: "quote_expired" }))).toBe(
      false,
    );
  });

  it("is discarded after a decline, or a fixed card still reports the old one", () => {
    // The other trap. A declined attempt leaves a row carrying the declined
    // PaymentIntent, and `finishPurchase` RETRIEVES an intent rather than
    // re-charging. Retrying under the same reference re-reports the decline no
    // matter what the buyer does about their card.
    expect(
      shouldReuseReference(new CommerceError("declined", { status: 402, reason: "card_declined" })),
    ).toBe(false);
  });

  it("is discarded after every other answered refusal", () => {
    // A 4xx is a verdict the server has made and recorded about this reference.
    for (const status of [400, 403, 409]) {
      expect(shouldReuseReference(new CommerceError("no", { status })), String(status)).toBe(false);
    }
  });
});

/**
 * The transport, with `fetch` stubbed.
 *
 * Everything above this point tests the DECISIONS against hand-built
 * `CommerceError`s, which leaves the link that produces those errors untested —
 * and that link is where the guarantee actually lives. `commerceRequest` is
 * what turns a rejected fetch into `status: null`, and `status: null` is the
 * sole input `shouldReuseReference` switches on to decide whether a retry
 * reuses the idempotency key or mints a new one. Replacing that catch block
 * with a bare `throw err` left every assertion in "the idempotency key" green
 * while turning a lost response into a second charge.
 *
 * `globalThis.fetch` is a plain assignment and an `afterEach` delete, the way
 * `is-typing.test.ts` stubs `document`: the runner is a Node environment by
 * design, so there is nothing to mock around.
 */
const host = globalThis as { fetch?: unknown };

afterEach(() => {
  delete host.fetch;
});

/** A response shaped like the two properties these functions read. */
function jsonResponse(status: number, body: unknown): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** Answer every call with this response. */
function respondWith(status: number, body: unknown): void {
  host.fetch = async () => jsonResponse(status, body);
}

/** Fail every call the way a dropped connection does. */
function failToReach(message = "Failed to fetch"): void {
  host.fetch = async () => {
    throw new TypeError(message);
  };
}

/** The error `submitPurchase` threw, as a `CommerceError`. */
async function purchaseError(): Promise<CommerceError> {
  const err = await submitPurchase("quote_1", "ref_1").then(
    () => null,
    (e: unknown) => e,
  );
  // Asserted rather than cast: a call that RESOLVED would otherwise read as an
  // error with every field undefined and pass nothing but `toBeUndefined`.
  expect(err, "submitPurchase resolved where it should have thrown").toBeInstanceOf(CommerceError);
  return err as CommerceError;
}

describe("a request that never got an answer", () => {
  it("throws with a null status, which is what preserves the idempotency key", async () => {
    // The two halves joined up. `submitPurchase` is the call that charges a
    // card, and a transport failure on it means the order row may already be
    // written and the card already charged with only the response lost.
    failToReach();
    const err = await purchaseError();
    expect(err.status).toBeNull();
    // And therefore the retry carries the SAME reference rather than buying
    // the thing twice. Replacing `commerceRequest`'s catch block with a bare
    // `throw err` breaks exactly this line and nothing else in the suite.
    expect(shouldReuseReference(err)).toBe(true);
  });
});

describe("a refusal, read off the wire", () => {
  it("maps a 402 body onto message, reason and decline code", async () => {
    // The panel renders `message`, routes on `reason` and the decline code is
    // the only word that says WHY a card was refused. A parser that dropped any
    // of the three would show "Could not complete that purchase." over a
    // perfectly explicit refusal.
    respondWith(402, {
      error: "Your card was declined.",
      reason: "card_declined",
      declineCode: "insufficient_funds",
    });
    const err = await purchaseError();
    expect(err.message).toBe("Your card was declined.");
    expect(err.status).toBe(402);
    expect(err.reason).toBe("card_declined");
    expect(err.declineCode).toBe("insufficient_funds");
  });

  it("carries that refusal through to settings, and spends the reference", async () => {
    // The end-to-end statement of the decline rule: an answered refusal is a
    // verdict about THIS reference, and `finishPurchase` retrieves an intent
    // rather than re-charging — so a retry under it re-reports the decline no
    // matter what the buyer does about their card.
    respondWith(402, { error: "Declined", reason: "card_declined" });
    const err = await purchaseError();
    expect(refusalAdvice(err).recourse).toBe("settings");
    expect(shouldReuseReference(err)).toBe(false);
  });

  it("falls back to a written sentence when the body carries no JSON", async () => {
    host.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });
    const err = await purchaseError();
    expect(err.message).toBe("Could not complete that purchase.");
    expect(err.status).toBe(500);
    // A 5xx is unanswered as far as the charge is concerned.
    expect(shouldReuseReference(err)).toBe(true);
  });
});

describe("commerce switched off is not an error", () => {
  it("reads a 404 as an empty surface on both reads", async () => {
    // 404 is what this whole router answers with when `KAX_COMMERCE_ENABLED`
    // is unset. Treating it as a failure would put an error where a shop with
    // no prints should simply have no prints, and would break `/orders` for
    // every deployment that has never turned commerce on.
    respondWith(404, { error: "Not found" });
    await expect(fetchPhysicalProducts(1)).resolves.toEqual([]);
    await expect(fetchPhysicalOrders()).resolves.toEqual([]);
  });

  it("still throws on a real failure, so the rule above is not 'ignore everything'", async () => {
    respondWith(500, { error: "boom" });
    await expect(fetchPhysicalProducts(1)).rejects.toBeInstanceOf(CommerceError);
    await expect(fetchPhysicalOrders()).rejects.toBeInstanceOf(CommerceError);
  });

  it("tolerates a 200 whose body is missing the array", async () => {
    // The server always sends one; a proxy serving an HTML error page with a
    // 200 does not, and `.map` on undefined would take the page down.
    respondWith(200, {});
    await expect(fetchPhysicalProducts(1)).resolves.toEqual([]);
    await expect(fetchPhysicalOrders()).resolves.toEqual([]);
  });
});

describe("the outcome table", () => {
  it("polls an outcome it has never seen, and never calls it settled", () => {
    // The safe default. `settled` would stop a tab watching a charge that is
    // still in flight and tell the buyer it is done on the strength of a word
    // this bundle does not know.
    expect(stepFor("some_outcome_from_the_future")).toBe("poll");
    expect(stepFor("")).toBe("poll");
  });

  it("acts on a bank challenge and settles on a verdict", () => {
    // Without this the assertion above would also pass against a function that
    // returned "poll" for everything, which would hang on every SCA challenge.
    expect(stepFor("requires_action")).toBe("authenticate");
    expect(stepFor("processing")).toBe("poll");
    for (const settled of ["paid", "failed", "canceled", "refunded", "chargeback"]) {
      expect(stepFor(settled), settled).toBe("settled");
    }
  });

  it("calls only `paid` a success", () => {
    // `refunded` and `chargeback` are settled AND reversed. A success test
    // written as "not failed" would show a green tick over money that went back.
    expect(isSuccessfulOutcome("paid")).toBe(true);
    for (const other of ["processing", "requires_action", "failed", "canceled", "refunded", "chargeback"]) {
      expect(isSuccessfulOutcome(other), other).toBe(false);
    }
  });
});

describe("the URLs", () => {
  it("calls paths the server actually mounts", () => {
    // A typo'd path is a 404, and `fetchPhysicalProducts` reads a 404 as "this
    // deployment has commerce switched off" — so the whole physical surface
    // disappears silently rather than erroring.
    const mounted = serverRoutes();
    expect(mounted, "no /commerce routes found — the parser has drifted").not.toHaveLength(0);
    expect(mounted).toContain("/commerce/quote");
    expect(mounted).toContain("/commerce/purchase");
    expect(mounted).toContain("/commerce/orders");
    expect(mounted).toContain("/commerce/orders/:ref");
    expect(mounted).toContain("/commerce/products/for-artifact/:artifactId");

    // And the client's literals resolve against that list. Each is written with
    // its parameter substituted the way the client builds it.
    expect(CLIENT_SOURCE).toContain('"/api/commerce/quote"');
    expect(CLIENT_SOURCE).toContain('"/api/commerce/purchase"');
    expect(CLIENT_SOURCE).toContain('"/api/commerce/orders"');
    expect(CLIENT_SOURCE).toContain("/api/commerce/orders/${encodeURIComponent(orderRef)}");
    expect(CLIENT_SOURCE).toContain("/api/commerce/products/for-artifact/${artifactId}");
  });

  it("never routes a physical purchase through the credit ledger", () => {
    // play_credit must not be able to buy a parcel. The server guarantees it
    // structurally — nothing on the physical path imports the ledger — and the
    // client half of the rule is that this module talks to /api/commerce and
    // nothing else. Comments are stripped first so the prose explaining the
    // rule does not fail it.
    const code = CLIENT_SOURCE.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/joinery|ledger|play_credit/i);
  });
});

describe("money", () => {
  it("renders integer cents as a price", () => {
    expect(formatMoney(2073, "usd")).toBe("$20.73");
    expect(formatMoney(0, "usd")).toBe("$0.00");
    expect(formatMoney(5, "usd")).toBe("$0.05");
    expect(formatMoney(100000, "usd")).toBe("$1,000.00");
  });

  it("does not throw on a currency Intl refuses", () => {
    // `Intl.NumberFormat` raises a RangeError on anything that is not three
    // letters, and a price list that throws takes the whole page with it.
    expect(() => formatMoney(2073, "")).not.toThrow();
    expect(formatMoney(2073, "credits")).toContain("20.73");
  });
});

describe("the two halves of one history", () => {
  const digital = (id: number, createdAt: string): DigitalOrder => ({
    id,
    status: "paid",
    amountCents: 500,
    currency: "usd",
    createdAt,
    listingId: id,
    artifactTitle: `Piece ${id}`,
  });
  const physical = (ref: string, createdAt: string): PhysicalOrder => ({
    orderRef: ref,
    status: "paid",
    orderStatus: "paid",
    fulfillmentState: "unfulfilled",
    sku: "kax-sticker-3.5in",
    currency: "usd",
    itemCents: 1564,
    shippingCents: 509,
    taxCents: 0,
    totalCents: 2073,
    createdAt,
    updatedAt: createdAt,
  });

  it("interleaves the two kinds by time rather than grouping them", () => {
    // A buyer remembers "the thing I bought on Tuesday", not which of two
    // Stripe integrations handled it. Concatenating the lists would put every
    // download above every print regardless of when either happened, and the
    // page would look sorted.
    const rows = mergeOrders(
      [digital(1, "2026-08-10T00:00:00.000Z"), digital(2, "2026-08-14T00:00:00.000Z")],
      [physical("a", "2026-08-12T00:00:00.000Z"), physical("b", "2026-08-16T00:00:00.000Z")],
    );
    expect(rows.map((r) => r.kind)).toEqual(["physical", "digital", "physical", "digital"]);
    expect(rows.map((r) => r.createdAt)).toEqual([
      "2026-08-16T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    ]);
  });

  it("survives either half being empty", () => {
    // Commerce switched off means no physical orders at all, and the digital
    // half still has to render.
    expect(mergeOrders([digital(1, "2026-08-10T00:00:00.000Z")], [])).toHaveLength(1);
    expect(mergeOrders([], [physical("a", "2026-08-10T00:00:00.000Z")])).toHaveLength(1);
    expect(mergeOrders([], [])).toEqual([]);
  });

  it("shows a fulfilment line only for an order that was actually paid for", () => {
    // "Not sent to production yet" beside a declined card reads as a queue the
    // buyer is waiting in, and they wait.
    expect(showsFulfillment({ orderStatus: "paid" })).toBe(true);
    expect(showsFulfillment({ orderStatus: "refunded" })).toBe(true);
    expect(showsFulfillment({ orderStatus: "payment_failed" })).toBe(false);
    expect(showsFulfillment({ orderStatus: "pending_payment" })).toBe(false);
    expect(showsFulfillment({ orderStatus: "canceled" })).toBe(false);
  });
});
