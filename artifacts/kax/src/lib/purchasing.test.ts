/**
 * purchasing.test.ts — the decisions behind the purchasing desk, called
 * directly.
 *
 * Three things here can go wrong quietly, and only quietly.
 *
 * A state the server can derive and the client has no words for renders a blank
 * header and a missing instruction: the account is stuck, the panel says
 * nothing about why, and nothing throws. The vocabulary lives in
 * `api-server/src/lib/purchasingState.ts`, so it is read from there as source
 * and compared — the same technique `unit-interior.test.ts` uses for the slot
 * list, and for the same reason: two lists in two packages drift, and the
 * failure is invisible from either side.
 *
 * A field name that does not match `AddressBody` is a 400 on a form the buyer
 * filled in correctly. So the keys the client sends are compared against the
 * keys the server's zod schema declares, again as source.
 *
 * And a consent gate that lets go is not visible at all until somebody looks at
 * a stored card nobody agreed to. `canSaveCard` is therefore tested one field
 * at a time, each flipped alone against an otherwise-passing input, so a gate
 * that stopped consulting consent could not pass by being true for some other
 * reason.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EMPTY_ADDRESS_DRAFT,
  PURCHASING_STATE_COPY,
  UNKNOWN_PURCHASING_STATE_COPY,
  addressDraftFromElement,
  addressDraftIsSavable,
  addressRequestBody,
  canSaveCard,
  formatSavedCard,
  purchasingCopy,
  type ShippingAddressDraft,
} from "./purchasing";

const here = dirname(fileURLToPath(import.meta.url));
const API_SERVER = join(here, "..", "..", "..", "api-server", "src");

function readServer(...parts: string[]): string {
  return readFileSync(join(API_SERVER, ...parts), "utf8").replace(/\r\n/g, "\n");
}

const PURCHASING_STATE_SOURCE = readServer("lib", "purchasingState.ts");
const PURCHASING_ROUTE_SOURCE = readServer("routes", "purchasing.ts");

/** Every state `derivePurchasingState` can put in `state` or `reasons`. */
function serverStates(): string[] {
  const start = PURCHASING_STATE_SOURCE.indexOf("export const PURCHASING_STATES = [");
  if (start < 0) throw new Error("PURCHASING_STATES is no longer declared the way this test reads it");
  const end = PURCHASING_STATE_SOURCE.indexOf("] as const;", start);
  if (end < 0) throw new Error("PURCHASING_STATES is no longer terminated the way this test reads it");
  return [...PURCHASING_STATE_SOURCE.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/** Every key `AddressBody` declares, i.e. everything `PUT /address` will read. */
function serverAddressFields(): string[] {
  const start = PURCHASING_ROUTE_SOURCE.indexOf("const AddressBody = z.object({");
  if (start < 0) throw new Error("AddressBody is no longer declared the way this test reads it");
  const end = PURCHASING_ROUTE_SOURCE.indexOf("\n});", start);
  if (end < 0) throw new Error("AddressBody is no longer terminated the way this test reads it");
  const body = PURCHASING_ROUTE_SOURCE.slice(start, end);
  return [...body.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
}

const COMPLETE_DRAFT: ShippingAddressDraft = {
  name: "Ada Lovelace",
  line1: "1 Analytical Way",
  line2: "",
  city: "Portland",
  region: "OR",
  postalCode: "97201",
  country: "US",
  phone: "",
  validated: false,
};

describe("purchasing state vocabulary", () => {
  it("has copy for every state the server can derive", () => {
    // The direction that leaves a buyer stuck with a blank header. Adding a
    // thirteenth state on the server and nothing here is a silent regression:
    // the panel renders, says nothing, and offers no way forward.
    const missing = serverStates().filter((s) => !(s in PURCHASING_STATE_COPY));
    expect(missing, "server states with no copy on the desk").toEqual([]);
  });

  it("does not carry copy for states the server cannot reach", () => {
    // The harmless direction, guarded anyway: dead copy reads as a state that
    // exists, and the next person spends an afternoon on why it never appears.
    const server = serverStates();
    const orphans = Object.keys(PURCHASING_STATE_COPY).filter((s) => !server.includes(s));
    expect(orphans, "copy for states nothing can derive").toEqual([]);
  });

  it("reads all twelve states out of the server, not a stub", () => {
    // Guards the guards. If the parser above stopped matching, both tests
    // would pass against an empty list and prove nothing at all.
    expect(serverStates()).toHaveLength(12);
    expect(serverStates()).toContain("pm_detached");
  });

  it("treats a state it has never heard of as blocking, never as ready", () => {
    // Reachable when a server is ahead of a cached bundle. The safe answer is
    // "you cannot buy yet" — the wrong one is a green Ready badge over an
    // account the purchase endpoint is about to refuse.
    const copy = purchasingCopy("some_state_from_the_future");
    expect(copy).toBe(UNKNOWN_PURCHASING_STATE_COPY);
    expect(copy.tone).toBe("blocked");
  });

  it("calls only `ready` and `card_expiring` buyable", () => {
    // The server's `isPurchasable` treats exactly one reason as advisory. A
    // tone table that disagreed would draw a blocked account as spendable.
    const buyable = Object.entries(PURCHASING_STATE_COPY)
      .filter(([, c]) => c.tone === "ok" || c.tone === "advisory")
      .map(([state]) => state)
      .sort();
    expect(buyable).toEqual(["card_expiring", "ready"]);
  });
});

describe("the consent gate", () => {
  const passing = { consentAccepted: true, termsLoaded: true, stripeReady: true, busy: false };

  it("lets a fully ready form save", () => {
    // Without this the four refusals below would also pass against a gate that
    // returned false unconditionally.
    expect(canSaveCard(passing)).toBe(true);
  });

  it("refuses to submit the payment element without consent", () => {
    // The criterion this component exists to satisfy. Confirming a SetupIntent
    // for an account that has accepted nothing stores a card we have no
    // recorded permission to charge.
    expect(canSaveCard({ ...passing, consentAccepted: false })).toBe(false);
  });

  it("refuses before the terms have loaded", () => {
    // There is no version to POST to /consent until the document carrying it
    // has arrived, so a checkbox ticked against nothing is not consent.
    expect(canSaveCard({ ...passing, termsLoaded: false })).toBe(false);
  });

  it("refuses before Stripe is ready", () => {
    expect(canSaveCard({ ...passing, stripeReady: false })).toBe(false);
  });

  it("refuses while a save is already in flight", () => {
    // Two SetupIntents from one form is two cards attached from one press.
    expect(canSaveCard({ ...passing, busy: true })).toBe(false);
  });
});

describe("the address form", () => {
  it("sends exactly the keys AddressBody declares", () => {
    // A client field name the server does not read is dropped by zod in
    // silence: the address saves, and the field it was carrying is simply
    // absent from the row. This is what would have caught `validated` being
    // sent to a schema that had no such key.
    const sent = Object.keys(addressRequestBody(COMPLETE_DRAFT)).sort();
    expect(sent).toEqual(serverAddressFields().sort());
  });

  it("reads a real field list off the server, not an empty one", () => {
    expect(serverAddressFields()).toContain("postalCode");
    expect(serverAddressFields()).toContain("validated");
  });

  it("translates Stripe's field names into the server's", () => {
    // `state` is `region` and `postal_code` is `postalCode`. Getting either
    // wrong is a 400 on a form the buyer filled in correctly.
    const draft = addressDraftFromElement(
      {
        name: "Ada Lovelace",
        phone: "+15035550100",
        address: {
          line1: "1 Analytical Way",
          line2: null,
          city: "Portland",
          state: "OR",
          postal_code: "97201",
          country: "us",
        },
      },
      true,
    );
    expect(draft.region).toBe("OR");
    expect(draft.postalCode).toBe("97201");
    expect(draft.line2).toBe("");
    expect(draft.country, "the server compares country case-sensitively after its own upcase").toBe("US");
  });

  it("carries Stripe's own completeness verdict rather than re-deriving one", () => {
    // `validated_at` is supposed to mean "something checked this". Recomputing
    // completeness from the fields would stamp it for an address nothing
    // checked, which is exactly the claim the column exists to avoid making.
    const filled = {
      name: "Ada Lovelace",
      address: {
        line1: "1 Analytical Way",
        city: "Portland",
        state: "OR",
        postal_code: "97201",
        country: "US",
      },
    };
    expect(addressDraftFromElement(filled, false).validated).toBe(false);
    expect(addressDraftFromElement(filled, true).validated).toBe(true);
  });

  it("will save an address the server accepts but Stripe has not called complete", () => {
    // The two questions are different on purpose: with the phone field switched
    // on, Stripe withholds `complete` for a field `AddressBody` marks optional.
    // Tying Save to `validated` would leave that buyer unable to submit a
    // perfectly valid address.
    expect(COMPLETE_DRAFT.validated).toBe(false);
    expect(addressDraftIsSavable(COMPLETE_DRAFT)).toBe(true);
    expect(addressRequestBody(COMPLETE_DRAFT)["validated"]).toBe(false);
  });

  it("refuses to save while a field the server requires is empty", () => {
    // One at a time against an otherwise-savable draft, so a check that stopped
    // consulting a given field cannot be carried past this by the others. The
    // blank is whitespace rather than "" because the server trims before it
    // applies `.min(1)`, so "   " is a value that looks present and is not.
    const blanked: Array<[string, Partial<ShippingAddressDraft>]> = [
      ["name", { name: "   " }],
      ["line1", { line1: "   " }],
      ["city", { city: "   " }],
      ["region", { region: "   " }],
      ["postalCode", { postalCode: "   " }],
      ["country", { country: "   " }],
    ];
    for (const [field, override] of blanked) {
      expect(addressDraftIsSavable({ ...COMPLETE_DRAFT, ...override }), field).toBe(false);
    }
    expect(addressDraftIsSavable(EMPTY_ADDRESS_DRAFT)).toBe(false);
  });

  it("sends an absent second line as null rather than as an empty one", () => {
    // "" says there is a second line and it is blank. Only one of those is
    // true, and it is the one that ends up on a shipping label.
    expect(addressRequestBody(COMPLETE_DRAFT)["line2"]).toBeNull();
    expect(addressRequestBody({ ...COMPLETE_DRAFT, line2: "Apt 3" })["line2"]).toBe("Apt 3");
  });
});

describe("the saved-card line", () => {
  it("names the card without ever holding one", () => {
    expect(formatSavedCard({ brand: "visa", last4: "4242", expMonth: 4, expYear: 2029 })).toBe(
      "Visa •••• 4242 · exp 04/2029",
    );
  });

  it("says so plainly when there is no card", () => {
    expect(formatSavedCard(null)).toBe("No card on file");
  });

  it("survives a card Stripe told us nothing about", () => {
    // Every field on `PurchasingCard` is nullable. A row written before Stripe
    // returned card details must not render "undefined •••• undefined".
    const label = formatSavedCard({ brand: null, last4: null, expMonth: null, expYear: null });
    expect(label).not.toContain("undefined");
    expect(label).not.toContain("null");
  });
});
