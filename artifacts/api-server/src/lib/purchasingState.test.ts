/**
 * purchasingState.test.ts — the gate is arithmetic over rows and a clock, and
 * every branch of it decides whether a real card gets charged.
 *
 * The reason this suite exists rather than a database one: the interesting
 * cases are instants. "A card expiring this month still works" is a statement
 * about the boundary between 23:59:59.999 on the last day and 00:00:00.000 on
 * the next, and there is no way to sit a Postgres fixture on that boundary. The
 * derivation takes `now` as an argument precisely so this file can.
 *
 * Every case below fails if the rule it names is removed — the expiry cases
 * fail if the month arithmetic is off by one in either direction, the
 * `pm_detached` case fails if detached rows stop being distinguished from
 * never-had-a-card, and the coverage case at the end fails if a state is added
 * to the vocabulary that nothing can actually produce.
 */

import { describe, expect, it } from "vitest";
import {
  CARD_EXPIRING_WINDOW_DAYS,
  CURRENT_STORED_CARD_TERMS_VERSION,
  DEFAULT_DAILY_ORDER_CAP,
  PURCHASING_STATES,
  SUPPORTED_SHIP_TO_COUNTRIES,
  derivePurchasingState,
  isPurchasable,
  resolveDailyOrderCap,
  type PurchasingFacts,
  type PurchasingPaymentMethodFacts,
  type PurchasingState,
} from "./purchasingState";

/** Mid-month, so nothing in the baseline sits on a boundary by accident. */
const NOW = new Date("2026-08-16T12:00:00.000Z");

function card(over: Partial<PurchasingPaymentMethodFacts> = {}): PurchasingPaymentMethodFacts {
  return {
    brand: "visa",
    last4: "4242",
    expMonth: 12,
    expYear: 2030,
    isDefault: true,
    detachedAt: null,
    ...over,
  };
}

/** An account with everything on file and nothing wrong with it. */
function facts(over: Partial<PurchasingFacts> = {}): PurchasingFacts {
  return {
    commerceEnabled: true,
    authenticated: true,
    address: { country: "US", postalCode: "97201" },
    paymentMethods: [card()],
    consent: { termsVersion: CURRENT_STORED_CARD_TERMS_VERSION },
    currentTermsVersion: CURRENT_STORED_CARD_TERMS_VERSION,
    chargeableOrdersLast24h: 0,
    dailyOrderCap: 5,
    supportedCountries: SUPPORTED_SHIP_TO_COUNTRIES,
    now: NOW,
    ...over,
  };
}

describe("derivePurchasingState — the §2 state table", () => {
  it("reports ready when everything is on file and current", () => {
    const snapshot = derivePurchasingState(facts());
    expect(snapshot.state).toBe("ready");
    expect(snapshot.reasons).toEqual([]);
    expect(isPurchasable(snapshot)).toBe(true);
    // The card and address still come back — the panel has to render them.
    expect(snapshot.card).toEqual({ brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 });
    expect(snapshot.shipsTo).toEqual({ country: "US", postalCode: "97201" });
    expect(snapshot.consentVersion).toBe(CURRENT_STORED_CARD_TERMS_VERSION);
  });

  it("reports disabled without describing the account at all", () => {
    // The flag being off is not "this account cannot buy", it is "there is no
    // shop". Returning the card and address anyway would leak both from a
    // deployment that has deliberately switched commerce off.
    const snapshot = derivePurchasingState(facts({ commerceEnabled: false }));
    expect(snapshot.state).toBe("disabled");
    expect(snapshot.reasons).toEqual(["disabled"]);
    expect(snapshot.card).toBeNull();
    expect(snapshot.shipsTo).toBeNull();
    expect(snapshot.consentVersion).toBeNull();
    expect(isPurchasable(snapshot)).toBe(false);
  });

  it("reports anonymous for a caller with no session", () => {
    const snapshot = derivePurchasingState(facts({ authenticated: false }));
    expect(snapshot.state).toBe("anonymous");
    expect(snapshot.card).toBeNull();
    expect(snapshot.shipsTo).toBeNull();
    expect(isPurchasable(snapshot)).toBe(false);
  });

  it("puts disabled ahead of anonymous — an unset flag outranks a missing session", () => {
    const snapshot = derivePurchasingState(
      facts({ commerceEnabled: false, authenticated: false }),
    );
    expect(snapshot.state).toBe("disabled");
  });

  it("reports not_configured for an account with nothing on file", () => {
    const snapshot = derivePurchasingState(facts({ address: null, paymentMethods: [] }));
    expect(snapshot.state).toBe("not_configured");
    // One reason, not three. Naming the missing halves separately here would
    // be telling someone who has never opened settings what is missing from
    // the settings they have never opened.
    expect(snapshot.reasons).not.toContain("needs_address");
    expect(snapshot.reasons).not.toContain("needs_payment_method");
  });

  it("names only the missing half when a card is on file but no address", () => {
    const snapshot = derivePurchasingState(facts({ address: null }));
    expect(snapshot.state).toBe("needs_address");
    expect(snapshot.reasons).toEqual(["needs_address"]);
  });

  it("names only the missing half when an address is on file but no card", () => {
    const snapshot = derivePurchasingState(facts({ paymentMethods: [] }));
    expect(snapshot.state).toBe("needs_payment_method");
    expect(snapshot.reasons).toEqual(["needs_payment_method"]);
  });

  it("distinguishes a removed card from a card that never existed", () => {
    // Both accounts have an address and no chargeable card. They get different
    // copy — "add a card" versus "your card was removed" — and this is the only
    // thing that tells them apart.
    const removed = derivePurchasingState(
      facts({ paymentMethods: [card({ detachedAt: new Date("2026-08-01T00:00:00.000Z") })] }),
    );
    expect(removed.state).toBe("pm_detached");
    expect(removed.reasons).not.toContain("needs_payment_method");
    // A detached card is not a card: nothing may render it as one.
    expect(removed.card).toBeNull();

    const never = derivePurchasingState(facts({ paymentMethods: [] }));
    expect(never.state).toBe("needs_payment_method");
  });

  it("reports consent_stale when the terms have moved past what was accepted", () => {
    const snapshot = derivePurchasingState(facts({ consent: { termsVersion: "v0" } }));
    expect(snapshot.state).toBe("consent_stale");
    // The accepted version is still reported, so the panel can say which one.
    expect(snapshot.consentVersion).toBe("v0");
  });

  it("reports consent_stale when nothing was ever accepted", () => {
    const snapshot = derivePurchasingState(facts({ consent: null }));
    expect(snapshot.state).toBe("consent_stale");
    expect(snapshot.consentVersion).toBeNull();
  });

  it("refuses a destination outside the supported list", () => {
    const snapshot = derivePurchasingState(
      facts({ address: { country: "GB", postalCode: "SW1A 1AA" } }),
    );
    expect(snapshot.state).toBe("unsupported_destination");
    // Not needs_address: they gave us one. Asking for it again is a dead end.
    expect(snapshot.reasons).not.toContain("needs_address");
  });

  it("does not treat a lowercase country code as a different country", () => {
    const snapshot = derivePurchasingState(
      facts({ address: { country: "us", postalCode: "97201" } }),
    );
    expect(snapshot.state).toBe("ready");
  });

  it("reports cap_reached at the cap, and not one order below it", () => {
    const at = derivePurchasingState(facts({ chargeableOrdersLast24h: 5, dailyOrderCap: 5 }));
    expect(at.state).toBe("cap_reached");
    expect(isPurchasable(at)).toBe(false);

    // The boundary is the whole rule: `>` instead of `>=` gives away one free
    // order past the limit, and this is the case that would notice.
    const below = derivePurchasingState(facts({ chargeableOrdersLast24h: 4, dailyOrderCap: 5 }));
    expect(below.state).toBe("ready");
  });

  it("counts a charge ATTEMPT, which is why the field is not named for paid orders", () => {
    // The count this module is handed is every order that represents a real
    // charge attempt — `pending_payment` and `authenticating` included — and
    // not only the settled ones. Counting `paid` alone made the cap blind to
    // every order between its INSERT and the webhook that settles it, which is
    // the whole lifetime of a burst. The derivation itself cannot see which
    // status produced the number, so what this pins is the contract: the field
    // is a count of attempts, and the query in `purchasingFacts.ts` is held to
    // it by the DB-backed cases in `commerce.test.ts`.
    const unsettled = derivePurchasingState(facts({ chargeableOrdersLast24h: 3, dailyOrderCap: 3 }));
    expect(unsettled.state).toBe("cap_reached");
    expect(isPurchasable(unsettled)).toBe(false);
  });

  it("carries a multi-reason account, not just its headline", () => {
    // The account the design document calls out by name: never set up, and the
    // terms have been bumped since it last agreed to anything.
    const snapshot = derivePurchasingState(
      facts({ address: null, paymentMethods: [], consent: { termsVersion: "v0" } }),
    );
    expect(snapshot.reasons).toEqual(["not_configured", "consent_stale"]);
    expect(snapshot.state).toBe("not_configured");
  });

  it("makes state the first reason, always", () => {
    const snapshot = derivePurchasingState(
      facts({
        address: { country: "GB", postalCode: "SW1A 1AA" },
        paymentMethods: [],
        consent: null,
        chargeableOrdersLast24h: 9,
        dailyOrderCap: 5,
      }),
    );
    expect(snapshot.reasons.length).toBeGreaterThan(1);
    expect(snapshot.state).toBe(snapshot.reasons[0]);
    expect(snapshot.reasons).toEqual([
      "unsupported_destination",
      "needs_payment_method",
      "consent_stale",
      "cap_reached",
    ]);
  });
});

describe("derivePurchasingState — card expiry against the clock", () => {
  it("does not expire a card until its printed month has ended", () => {
    // 08/2026, asked on the last instant of August 2026. A card is good through
    // the last day of the month printed on it; anything that treats the 1st of
    // the month as the expiry instant fails here.
    const lastInstant = new Date("2026-08-31T23:59:59.999Z");
    const snapshot = derivePurchasingState(
      facts({ paymentMethods: [card({ expMonth: 8, expYear: 2026 })], now: lastInstant }),
    );
    expect(snapshot.reasons).not.toContain("card_expired");
    expect(isPurchasable(snapshot)).toBe(true);
  });

  it("expires it the instant the next month begins", () => {
    const nextMonth = new Date("2026-09-01T00:00:00.000Z");
    const snapshot = derivePurchasingState(
      facts({ paymentMethods: [card({ expMonth: 8, expYear: 2026 })], now: nextMonth }),
    );
    expect(snapshot.state).toBe("card_expired");
    expect(isPurchasable(snapshot)).toBe(false);
    // The expired card is still reported: "your card expired 08/26" needs it.
    expect(snapshot.card).toEqual({ brand: "visa", last4: "4242", expMonth: 8, expYear: 2026 });
  });

  it("rolls the year for a December expiry", () => {
    const pm = [card({ expMonth: 12, expYear: 2026 })];
    const stillGood = derivePurchasingState(
      facts({ paymentMethods: pm, now: new Date("2026-12-31T23:59:59.999Z") }),
    );
    expect(stillGood.reasons).not.toContain("card_expired");

    const gone = derivePurchasingState(
      facts({ paymentMethods: pm, now: new Date("2027-01-01T00:00:00.000Z") }),
    );
    expect(gone.state).toBe("card_expired");
  });

  it("warns inside the expiring window without blocking the purchase", () => {
    // Expiry instant is 2026-10-01; 30 days before it is inside the 45-day
    // window and the account is still buyable.
    const snapshot = derivePurchasingState(
      facts({
        paymentMethods: [card({ expMonth: 9, expYear: 2026 })],
        now: new Date("2026-09-01T00:00:00.000Z"),
      }),
    );
    expect(snapshot.state).toBe("card_expiring");
    expect(snapshot.reasons).toEqual(["card_expiring"]);
    expect(isPurchasable(snapshot)).toBe(true);
  });

  it("says nothing about a card that is comfortably outside the window", () => {
    const outside = new Date(
      Date.UTC(2026, 10, 1) - (CARD_EXPIRING_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    const snapshot = derivePurchasingState(
      facts({ paymentMethods: [card({ expMonth: 10, expYear: 2026 })], now: outside }),
    );
    expect(snapshot.state).toBe("ready");
  });

  it("lets a blocking reason outrank the expiring warning", () => {
    const snapshot = derivePurchasingState(
      facts({
        paymentMethods: [card({ expMonth: 9, expYear: 2026 })],
        now: new Date("2026-09-01T00:00:00.000Z"),
        chargeableOrdersLast24h: 5,
        dailyOrderCap: 5,
      }),
    );
    expect(snapshot.state).toBe("cap_reached");
    expect(snapshot.reasons).toEqual(["cap_reached", "card_expiring"]);
    expect(isPurchasable(snapshot)).toBe(false);
  });

  it("claims nothing about a card whose expiry it does not know", () => {
    // Null columns and impossible months both mean "no answer". Inventing one
    // either blocks a working card or blesses a dead one.
    for (const bad of [
      card({ expMonth: null, expYear: null }),
      card({ expMonth: 13, expYear: 2026 }),
      card({ expMonth: 0, expYear: 2026 }),
    ]) {
      const snapshot = derivePurchasingState(
        facts({ paymentMethods: [bad], now: new Date("2030-01-01T00:00:00.000Z") }),
      );
      expect(snapshot.reasons).not.toContain("card_expired");
      expect(snapshot.reasons).not.toContain("card_expiring");
    }
  });
});

describe("derivePurchasingState — which card it is talking about", () => {
  it("prefers the default over the more recent one", () => {
    const snapshot = derivePurchasingState(
      facts({
        paymentMethods: [
          card({ last4: "1111", isDefault: false }),
          card({ last4: "2222", isDefault: true }),
        ],
      }),
    );
    expect(snapshot.card?.last4).toBe("2222");
  });

  it("falls back to the most recent when nothing is marked default", () => {
    const snapshot = derivePurchasingState(
      facts({
        paymentMethods: [
          card({ last4: "1111", isDefault: false }),
          card({ last4: "2222", isDefault: false }),
        ],
      }),
    );
    expect(snapshot.card?.last4).toBe("1111");
  });

  it("never selects a detached card, even one marked default", () => {
    // Stripe keeps `default` on a detached method. Charging it is a guaranteed
    // failure, so the attached card has to win.
    const snapshot = derivePurchasingState(
      facts({
        paymentMethods: [
          card({ last4: "1111", isDefault: true, detachedAt: new Date("2026-08-01T00:00:00.000Z") }),
          card({ last4: "2222", isDefault: false }),
        ],
      }),
    );
    expect(snapshot.card?.last4).toBe("2222");
    expect(snapshot.state).toBe("ready");
  });
});

describe("resolveDailyOrderCap", () => {
  it("uses the default when unset", () => {
    expect(resolveDailyOrderCap(undefined)).toBe(DEFAULT_DAILY_ORDER_CAP);
  });

  it("honours a positive integer", () => {
    expect(resolveDailyOrderCap("3")).toBe(3);
  });

  it("falls back rather than removing the limit", () => {
    // Every one of these would be "no cap" if the parse result were trusted,
    // and a typo in a limit must never read as permission.
    for (const bad of ["", "0", "-1", "abc", "2.5", "NaN", "1e3x"]) {
      expect(resolveDailyOrderCap(bad), `cap from ${JSON.stringify(bad)}`).toBe(
        DEFAULT_DAILY_ORDER_CAP,
      );
    }
  });
});

describe("the state vocabulary", () => {
  it("can actually produce every state it declares", () => {
    // A state nobody can reach is a state the panel has copy for and will never
    // show. This fails both ways: adding an unreachable state to the list, and
    // adding a reachable state that this suite forgot to exercise.
    const produced = new Set<PurchasingState>(
      [
        facts({ commerceEnabled: false }),
        facts({ authenticated: false }),
        facts({ address: null, paymentMethods: [] }),
        facts({ address: { country: "GB", postalCode: "SW1A 1AA" } }),
        facts({ address: null }),
        facts({ paymentMethods: [] }),
        facts({ paymentMethods: [card({ detachedAt: new Date("2026-08-01T00:00:00.000Z") })] }),
        facts({ paymentMethods: [card({ expMonth: 1, expYear: 2020 })] }),
        facts({ consent: null }),
        facts({ chargeableOrdersLast24h: 5, dailyOrderCap: 5 }),
        facts({
          paymentMethods: [card({ expMonth: 9, expYear: 2026 })],
          now: new Date("2026-09-01T00:00:00.000Z"),
        }),
        facts(),
      ].map((f) => derivePurchasingState(f).state),
    );
    expect([...produced].sort()).toEqual([...PURCHASING_STATES].sort());
  });
});

/**
 * An instrument that cannot be charged must not read as ready.
 *
 * A bank debit or a wallet comes back from Stripe with no `card` object, so
 * `brand` and `last4` land NULL. Before the save path refused those, one could
 * reach the table — and `selectCard` would pick it, the account would derive
 * `ready`, the dashboard would show the `•••• ????` placeholder, and the
 * purchase would confirm a mandate-based method on-session and raise something
 * that is not a decline. The buyer got a 500 with nothing to act on.
 */
describe("an instrument with no card behind it", () => {
  it("is never selected, so the account does not read as ready", () => {
    const snapshot = derivePurchasingState(
      facts({ paymentMethods: [card({ brand: null, last4: null, expMonth: null, expYear: null })] }),
    );
    expect(snapshot.state).not.toBe("ready");
    expect(snapshot.card).toBeNull();
    expect(isPurchasable(snapshot)).toBe(false);
  });

  it("loses to a real card rather than shadowing it", () => {
    // The unusable row is the DEFAULT, so it would otherwise win outright.
    const snapshot = derivePurchasingState(
      facts({
        paymentMethods: [
          card({ brand: null, last4: null, expMonth: null, expYear: null, isDefault: true }),
          card({ last4: "4242", isDefault: false }),
        ],
      }),
    );
    expect(snapshot.state).toBe("ready");
    expect(snapshot.card?.last4).toBe("4242");
  });
});
