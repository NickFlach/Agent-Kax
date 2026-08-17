/**
 * printifyConfig.test.ts — the shop, the flag, and the address mapping, with no
 * Postgres anywhere near them.
 *
 * These were cases inside `printifyClient.test.ts`, behind a `beforeEach` that
 * creates three users and a product row. `getPrintifyConfig`, `printifyEnabled`
 * and `addressToFromSnapshot` are pure functions, and a config-validation
 * regression that is only catchable when the database service happens to be up
 * is a regression that ships on the day it is not. `purchasingState.ts` was
 * split from `purchasingFacts.ts` for exactly this reason and states it in its
 * own header — a unit test of arithmetic should not need a connection pool.
 * Nothing imported here reaches `@workspace/db`.
 *
 * **The shop is the reason this file exists at all.** A defaulted shop id is the
 * quietest failure in the whole feature: the account's list still contains an
 * old Shopify-channel store, so "just use the first one" would not throw — it
 * would manufacture into a storefront nobody meant to sell from. Nothing in an
 * HTTP response can catch that, so the check is made against the SOURCE, and
 * against EVERY source rather than the two files that happen to hold the
 * fulfilment code today. A `GET /shops.json` fallback introduced in a new lib
 * helper, or a shop id pinned as a literal in a script, is exactly as damaging.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addressToFromSnapshot,
  getPrintifyConfig,
  getUncachablePrintifyClient,
  printifyEnabled,
  PrintifyNotConfiguredError,
} from "./printifyClient";

/** A token shaped like the real one, and never the real one. */
const TEST_TOKEN = "kax-test-printify-token-4f2b";
/** A shop id that is neither the Shopify store nor the KAX store. */
const TEST_SHOP_ID = "10000001";

const SNAPSHOT_ADDRESS = {
  shipToName: "Ada Test Buyer",
  shipToLine1: "1 Snapshot Way",
  shipToLine2: "Apt 4",
  shipToCity: "Portland",
  shipToRegion: "OR",
  shipToPostalCode: "97201",
  shipToCountry: "US",
  shipToPhone: "+15035550100",
} as const;

const ENV_KEYS = [
  "KAX_PRINTIFY_ENABLED",
  "KAX_PRINTIFY_API_TOKEN",
  "KAX_PRINTIFY_SHOP_ID",
  "KAX_PRINTIFY_CONTACT_EMAIL",
] as const;

/** This file, which necessarily names both banned shop ids. */
const THIS_FILE = fileURLToPath(import.meta.url);
/** Everywhere a shop id or a shop-listing call could be introduced instead. */
const SCANNED_ROOTS = [
  fileURLToPath(new URL("..", import.meta.url)),
  fileURLToPath(new URL("../../../../scripts", import.meta.url)),
];

async function scannedSources(): Promise<Array<{ path: string; code: string }>> {
  const out: Array<{ path: string; code: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "build", ".git"].includes(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
      if (full === THIS_FILE) continue;
      out.push({ path: full, code: await readFile(full, "utf8") });
    }
  };
  for (const root of SCANNED_ROOTS) await walk(root);
  return out;
}

describe("the Printify shop is configuration and nothing else", () => {
  const priorEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
    process.env["KAX_PRINTIFY_ENABLED"] = "1";
    process.env["KAX_PRINTIFY_API_TOKEN"] = TEST_TOKEN;
    process.env["KAX_PRINTIFY_SHOP_ID"] = TEST_SHOP_ID;
    delete process.env["KAX_PRINTIFY_CONTACT_EMAIL"];
  });

  afterEach(() => {
    // Single-fork runner: a leaked flag decides which branch a later file takes.
    for (const key of ENV_KEYS) {
      const prior = priorEnv.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("names the shop-listing endpoint nowhere in the server or the scripts", async () => {
    // `GET /v1/shops.json` returns the account's shops, the first of which is
    // still the Shopify-channel store — so a "sensible default" would find it
    // and print into somebody else's storefront without erroring. The string is
    // banned outright, in code and in prose alike, because a commented-out
    // fallback is a fallback somebody uncomments.
    const sources = await scannedSources();
    expect(sources.length, "the scan read nothing, so it proves nothing").toBeGreaterThan(20);
    for (const { path, code } of sources) {
      expect(code, path).not.toContain("shops.json");
    }
  });

  it("carries no shop id as a literal anywhere — not the wrong one, not the right one", async () => {
    // 28599902 is the Shopify store that must never be used; the real KAX shop
    // id must not be pinned either, or a change of store becomes a code change
    // and a rotated deployment prints from the wrong one.
    const sources = await scannedSources();
    expect(sources.length).toBeGreaterThan(20);
    for (const { path, code } of sources) {
      expect(code, path).not.toMatch(/\b28599902\b/);
      expect(code, path).not.toMatch(/\b28604869\b/);
    }
  });

  it("refuses to build a client without KAX_PRINTIFY_SHOP_ID", () => {
    // The refusal is the substitute for the fallback. Remove it and the only
    // remaining behaviour is "submit to no shop at all", which is a 404 from
    // Printify at the worst possible moment — or, with a fallback, worse.
    delete process.env["KAX_PRINTIFY_SHOP_ID"];
    expect(() => getUncachablePrintifyClient()).toThrow(PrintifyNotConfiguredError);
    expect(() => getPrintifyConfig()).toThrow(/KAX_PRINTIFY_SHOP_ID/);
  });

  it("refuses a shop id that is not a shop id", () => {
    process.env["KAX_PRINTIFY_SHOP_ID"] = "my-kax-store";
    expect(() => getUncachablePrintifyClient()).toThrow(PrintifyNotConfiguredError);
  });

  it("refuses to build a client without KAX_PRINTIFY_API_TOKEN, empty included", () => {
    delete process.env["KAX_PRINTIFY_API_TOKEN"];
    expect(() => getUncachablePrintifyClient()).toThrow(PrintifyNotConfiguredError);
    // A present-but-empty secret is not a secret: it reaches an Authorization
    // header as a well-formed bearer of nothing.
    process.env["KAX_PRINTIFY_API_TOKEN"] = "   ";
    expect(() => getUncachablePrintifyClient()).toThrow(PrintifyNotConfiguredError);
  });

  it("reads configuration per call rather than caching a client", () => {
    // `stripeClient.ts`'s property, for the same reason: a rotated token or a
    // corrected shop must take effect on the next request, not the next
    // restart. Hoist the config into a module variable and this fails.
    expect(getUncachablePrintifyClient().shopId).toBe(TEST_SHOP_ID);
    process.env["KAX_PRINTIFY_SHOP_ID"] = "10000002";
    expect(getUncachablePrintifyClient().shopId).toBe("10000002");
  });

  it("reads the flag as the commerce surface does", () => {
    for (const value of ["1", "true"]) {
      process.env["KAX_PRINTIFY_ENABLED"] = value;
      expect(printifyEnabled()).toBe(true);
    }
    for (const value of ["0", "false", "yes", ""]) {
      process.env["KAX_PRINTIFY_ENABLED"] = value;
      expect(printifyEnabled()).toBe(false);
    }
    delete process.env["KAX_PRINTIFY_ENABLED"];
    expect(printifyEnabled()).toBe(false);
  });
});

describe("addressToFromSnapshot", () => {
  const priorContact = process.env["KAX_PRINTIFY_CONTACT_EMAIL"];

  afterEach(() => {
    if (priorContact === undefined) delete process.env["KAX_PRINTIFY_CONTACT_EMAIL"];
    else process.env["KAX_PRINTIFY_CONTACT_EMAIL"] = priorContact;
  });

  it("maps every ship_to_* column onto Printify's field names", () => {
    const addressTo = addressToFromSnapshot(SNAPSHOT_ADDRESS);
    expect(addressTo).toEqual({
      first_name: "Ada",
      last_name: "Test Buyer",
      phone: SNAPSHOT_ADDRESS.shipToPhone,
      country: "US",
      region: "OR",
      address1: "1 Snapshot Way",
      address2: "Apt 4",
      city: "Portland",
      zip: "97201",
    });
  });

  it("omits the optional fields rather than sending nulls", () => {
    // `address2: null` is a value Printify validates and rejects; an absent key
    // is not.
    const addressTo = addressToFromSnapshot({
      ...SNAPSHOT_ADDRESS,
      shipToLine2: null,
      shipToPhone: null,
    });
    expect(addressTo).not.toHaveProperty("address2");
    expect(addressTo).not.toHaveProperty("phone");
  });

  it("sends the merchant's own contact address, never the buyer's", () => {
    // There is no email on the snapshot, and reading the buyer's out of `users`
    // is precisely the live join this path forbids. What goes out is the
    // configured merchant contact — and with send_shipping_notification false,
    // Printify mails nobody about the order at all.
    process.env["KAX_PRINTIFY_CONTACT_EMAIL"] = "fulfilment@example.test";
    expect(addressToFromSnapshot(SNAPSHOT_ADDRESS).email).toBe("fulfilment@example.test");
    delete process.env["KAX_PRINTIFY_CONTACT_EMAIL"];
    expect(addressToFromSnapshot(SNAPSHOT_ADDRESS)).not.toHaveProperty("email");
  });

  it("sends a one-word name as both halves rather than an empty field", () => {
    // It reads oddly on a packing slip and it arrives, which is the correct
    // trade for an address field.
    const addressTo = addressToFromSnapshot({ ...SNAPSHOT_ADDRESS, shipToName: "Prince" });
    expect(addressTo.first_name).toBe("Prince");
    expect(addressTo.last_name).toBe("Prince");
  });
});

/**
 * `findOrderByExternalId`, attacked directly.
 *
 * This is the function whose `null` authorises a submission. The route and
 * worker suites prove what the callers do with the answer; these prove the
 * answer itself, with no Postgres in the way — the same reason the config cases
 * above live here rather than behind a `beforeEach` that needs a database.
 *
 * The rule the whole thing rests on: `null` means a COMPLETED search over pages
 * this adapter understood. Everything else throws.
 */
describe("findOrderByExternalId", () => {
  const priorEnv = new Map<string, string | undefined>();
  let pages: Array<{ status: number; body: unknown }> = [];
  let requested: string[] = [];

  /** One listed order, in the shape the live API returns — no `external_id`. */
  function row(id: string, label: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      app_order_id: null,
      shop_id: Number(TEST_SHOP_ID),
      address_to: {
        first_name: "Someone",
        last_name: "Else",
        country: "US",
        region: "NY",
        address1: "500 Not Our Street",
        city: "New York",
        zip: "10001",
      },
      line_items: [{ variant_id: 65212, quantity: 1 }],
      metadata: { order_type: "external", shop_order_id: 987654321, shop_order_label: label },
      total_price: 354,
      total_shipping: 509,
      total_tax: 0,
      status: "in-production",
      shipping_method: 1,
      created_at: "2026-08-14 18:02:11+00:00",
      sent_to_production_at: "2026-08-14 18:17:40+00:00",
      fulfilment_type: "ordinary",
      printify_connect: { url: null, id: null },
      sales_channel_type_id: 1,
      ...extra,
    };
  }

  function page(rows: unknown[], opts: { currentPage?: number; lastPage?: number } = {}) {
    const currentPage = opts.currentPage ?? 1;
    const lastPage = opts.lastPage ?? 1;
    return {
      current_page: currentPage,
      data: rows,
      first_page_url: "https://api.printify.com/v1/shops/x/orders.json?page=1",
      from: rows.length === 0 ? null : 1,
      last_page: lastPage,
      last_page_url: "https://api.printify.com/v1/shops/x/orders.json?page=" + lastPage,
      links: [],
      next_page_url: currentPage < lastPage ? "..." : null,
      path: "https://api.printify.com/v1/shops/x/orders.json",
      per_page: 50,
      prev_page_url: currentPage > 1 ? "..." : null,
      to: rows.length === 0 ? null : rows.length,
      total: rows.length,
    };
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
    process.env["KAX_PRINTIFY_ENABLED"] = "1";
    process.env["KAX_PRINTIFY_API_TOKEN"] = TEST_TOKEN;
    process.env["KAX_PRINTIFY_SHOP_ID"] = TEST_SHOP_ID;
    pages = [];
    requested = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        requested.push(String(input));
        // The last page queued keeps answering, so a case that wants "every
        // page looks like this" queues one and a case that wants a sequence
        // queues several.
        const next = pages.length > 1 ? pages.shift()! : pages[0];
        return {
          ok: next.status >= 200 && next.status < 300,
          status: next.status,
          text: async () =>
            typeof next.body === "string" ? next.body : JSON.stringify(next.body),
        } as unknown as Response;
      }),
    );
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prior = priorEnv.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    vi.unstubAllGlobals();
  });

  it("matches metadata.shop_order_label, which is where Printify echoes it", async () => {
    // BLOCKER 1. The captured response has NO top-level `external_id`, in this
    // projection or in the detail one. Reading `row.external_id` yields
    // `undefined` on every row: nothing matches, the scan reaches the declared
    // last page, and `null` — "definitively absent" — goes back to a caller
    // whose next move is to post the order again. The guard against a duplicate
    // was the thing guaranteeing one.
    const ref = "ce703bd3-407c-4136-aae4-0eadac65b90f";
    const listed = row("68f0e4a2b1c3d40001a2b3c4", ref);
    expect(listed, "the fixture invented a field Printify does not send").not.toHaveProperty(
      "external_id",
    );
    pages = [{ status: 200, body: page([row("other", "not-ours"), listed]) }];

    await expect(getUncachablePrintifyClient().findOrderByExternalId(ref)).resolves.toEqual({
      id: "68f0e4a2b1c3d40001a2b3c4",
      status: "in-production",
    });
  });

  it("falls back to a top-level external_id if one is ever sent", async () => {
    // No observed response carries one, but another plan or a later API version
    // might, and missing an order that was right there costs a second parcel.
    const ref = "ce703bd3-407c-4136-aae4-0eadac65b90f";
    pages = [
      {
        status: 200,
        body: page([row("with-external-id", "some-other-label", { external_id: ref })]),
      },
    ];

    await expect(getUncachablePrintifyClient().findOrderByExternalId(ref)).resolves.toMatchObject({
      id: "with-external-id",
    });
  });

  it("matches exactly, never by prefix or case", async () => {
    // The id it returns is written onto a paying customer's row and is what
    // every later step acts on, so a fuzzy match would send somebody else's
    // parcel to production against this buyer's money.
    const ref = "ce703bd3-407c-4136-aae4-0eadac65b90f";
    pages = [
      {
        status: 200,
        body: page([
          row("prefix", ref.slice(0, 8)),
          row("upper", ref.toUpperCase()),
          row("suffixed", ref + "-2"),
        ]),
      },
    ];

    await expect(getUncachablePrintifyClient().findOrderByExternalId(ref)).resolves.toBeNull();
  });

  it("answers null for a completed search over a well-formed empty page", async () => {
    // The positive control. Without it every "throws" case below would pass
    // against a function that had simply stopped answering — and a real absence
    // has to be reportable, or nothing is ever submitted at all.
    pages = [{ status: 200, body: page([]) }];
    await expect(getUncachablePrintifyClient().findOrderByExternalId("nope")).resolves.toBeNull();
  });

  it("THROWS on a page it could not parse instead of calling it an absence", async () => {
    // BLOCKER 2. `Array.isArray(obj.data) ? obj.data : []` turned every one of
    // these into a page with no entries — which the pager read as the end of
    // the list and reported as "definitively absent", on the one code path
    // whose next step is posting the order again.
    //
    // Note the contradiction it produced: the SAME `{}` raises the ambiguous
    // error on the submission POST — "we cannot tell, do not resubmit" — and
    // used to mean "certainly not there, resubmit" on this GET.
    for (const body of [
      {},
      [],
      { orders: [] },
      { data: [] },
      { data: [], last_page: 1 },
      { data: [], current_page: 1, last_page: 1 },
      { data: "nope", current_page: 1, last_page: 1, total: 0 },
      "<html>502 Bad Gateway</html>",
    ]) {
      pages = [{ status: 200, body }];
      await expect(
        getUncachablePrintifyClient().findOrderByExternalId("ref"),
        JSON.stringify(body) + " was read as a page",
      ).rejects.toThrow(/not in the expected shape|not JSON/);
    }
  });

  it("THROWS rather than returning absent when the request itself fails", async () => {
    pages = [{ status: 503, body: { code: 503, message: "Service unavailable" } }];
    await expect(getUncachablePrintifyClient().findOrderByExternalId("ref")).rejects.toThrow();
  });

  it("THROWS when it runs out of pages before the end of the list", async () => {
    // A pager that gives up and says "not found" is a pager that authorises a
    // duplicate. The budget bounds a pathological loop; it is not a depth at
    // which an absence may be inferred.
    pages = [{ status: 200, body: page([row("other", "not-ours")], { lastPage: 999 }) }];
    await expect(getUncachablePrintifyClient().findOrderByExternalId("ref")).rejects.toThrow(
      /page budget/,
    );
    expect(requested.length, "the pager stopped after one page").toBeGreaterThan(1);
  });
});
