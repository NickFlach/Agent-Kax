/**
 * commerceSchema.test.ts — the physical-commerce tables have to keep the
 * properties they were given, not merely exist.
 *
 * Every table in this repo passes "it is present". The things that make
 * `commerce_orders` safe to charge a card against are narrower than that and
 * every one of them is invisible to a schema self-check: the absence of a
 * foreign key, the width of a status column, the unit of a money column, and
 * a uniqueness rule that is the idempotency key for an entire purchase. Each
 * test below fails if its property is removed, which is the only reason to
 * write it.
 *
 * Runs against CI's real Postgres. There is no way to assert any of this
 * against a mock, because all of it is the database's behaviour rather than
 * ours.
 */

import { afterAll, describe, expect, it } from "vitest";
import { is, sql } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { db } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { cleanupTestData, createTestUser, makeTestId } from "../test-helpers";

/** Tables migration 0026 adds. Each must reach the database AND the barrel. */
const NEW_TABLES = [
  "user_shipping_addresses",
  "user_payment_methods",
  "user_purchasing_consents",
  "commerce_products",
  "commerce_orders",
] as const;

/** A live address row for `userId`, returning its id. */
async function insertAddress(userId: string): Promise<string> {
  const r = await db.execute(sql`
    INSERT INTO user_shipping_addresses
      (user_id, name, line1, city, region, postal_code, country)
    VALUES (${userId}, 'Test Buyer', '1 Test Way', 'Portland', 'OR', '97201', 'US')
    RETURNING id`);
  return (r.rows[0] as { id: string }).id;
}

/**
 * An order with the address copied onto it, exactly as the purchase path will
 * write one: every ship_to_* value is a literal, and nothing ties the row back
 * to the address it came from.
 */
async function insertOrder(userId: string, clientReference: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO commerce_orders
      (client_reference, buyer_user_id, sku, item_cents, shipping_cents, total_cents,
       ship_to_name, ship_to_line1, ship_to_city, ship_to_region, ship_to_postal_code,
       ship_to_country)
    VALUES (${clientReference}, ${userId}, 'kax-sticker-3.5in', 1564, 509, 2073,
            'Test Buyer', '1 Test Way', 'Portland', 'OR', '97201', 'US')
    RETURNING id`);
  return (r.rows[0] as { id: number }).id;
}

/** Foreign keys declared ON `table`, as "column -> referenced_table". */
async function outgoingForeignKeys(table: string): Promise<string[]> {
  const r = await db.execute(sql`
    SELECT kcu.column_name AS col, ccu.table_name AS ref
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = ${table}`);
  return r.rows
    .map((row) => `${(row as { col: string }).col} -> ${(row as { ref: string }).ref}`)
    .sort();
}

/** information_schema data_type for each named column of `table`. */
async function columnTypes(table: string, columns: string[]): Promise<Record<string, string>> {
  const r = await db.execute(sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`);
  const all = new Map(
    r.rows.map((row) => [
      (row as { column_name: string }).column_name,
      (row as { data_type: string }).data_type,
    ]),
  );
  const out: Record<string, string> = {};
  for (const c of columns) out[c] = all.get(c) ?? "MISSING";
  return out;
}

describe("physical-commerce schema", () => {
  afterAll(async () => { await cleanupTestData(); });

  it("registers every new table in the drizzle barrel", async () => {
    // schemaSelfCheck derives its expectations from Object.values(schema). A
    // table written by the migration but never exported here is silently
    // unchecked at boot — the two-of-three state residence_units was in the day
    // the deploy diff first ate it — so the barrel is asserted directly rather
    // than trusted.
    const exported = new Set<string>();
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      exported.add(getTableConfig(value as PgTable).name);
    }
    for (const t of NEW_TABLES) {
      expect([...exported], `${t} is missing from lib/db/src/schema/index.ts`).toContain(t);
    }
  });

  it("keeps commerce_orders free of a foreign key to any table the deploy diff can drop", async () => {
    // The one permitted reference is the buyer. In particular there is no
    // listing_id: listing_orders' FK to store_listings cascades, so a delisting
    // would destroy the record of a card charge — and store_listings.price is
    // the unit ambiguity of #269, which the physical path must never touch.
    // There is also no address FK; see the snapshot test below.
    const fks = await outgoingForeignKeys("commerce_orders");
    expect(fks).toEqual(["buyer_user_id -> users"]);
  });

  it("charges no order against a buyer who does not exist", async () => {
    // The FK asserted above has to be real. Without this, a table that had lost
    // it would still satisfy the equality check by having no foreign keys at
    // all, and a paid order could be attributed to nobody.
    await expect(
      db.execute(sql`
        INSERT INTO commerce_orders
          (client_reference, buyer_user_id, sku, item_cents, total_cents,
           ship_to_name, ship_to_line1, ship_to_city, ship_to_region,
           ship_to_postal_code, ship_to_country)
        VALUES (${makeTestId("ref-orphan")}, 'kax-test-no-such-user', 'kax-sticker-3.5in',
                1564, 2073, 'X', '1 Test Way', 'Portland', 'OR', '97201', 'US')`),
      "an order was accepted for a buyer that does not exist",
    ).rejects.toThrow();
  });

  it("refuses a second order under the same client_reference", async () => {
    // This uniqueness IS the idempotency key for the whole purchase: the row is
    // written first with ON CONFLICT DO NOTHING on this target, and the conflict
    // is what tells a retry to read back the existing order instead of charging
    // the card a second time. Without the constraint the retry silently opens a
    // second order and the buyer pays twice.
    const user = await createTestUser();
    const ref = makeTestId("ref-dup");
    await insertOrder(user.id, ref);
    await expect(
      insertOrder(user.id, ref),
      "a second order reused a client_reference",
    ).rejects.toThrow();
  });

  it("keeps the shipping address a snapshot, so editing it cannot rewrite a shipped order", async () => {
    // The point of the ship_to_* columns. A foreign key to
    // user_shipping_addresses would make a buyer moving house either rewrite
    // where an already-shipped order went (and take the dispute evidence with
    // it) or, on a cascade, delete the order outright.
    const user = await createTestUser();
    const addressId = await insertAddress(user.id);
    const ref = makeTestId("ref-snapshot");
    const orderId = await insertOrder(user.id, ref);

    // The buyer moves, and then the old address is removed entirely. Under a
    // cascade this deletes the order; under a restrict it raises; under a
    // snapshot nothing happens to it at all.
    await db.execute(sql`
      UPDATE user_shipping_addresses
      SET line1 = '99 Somewhere Else', city = 'Seattle', region = 'WA', postal_code = '98101'
      WHERE id = ${addressId}`);
    await db.execute(sql`DELETE FROM user_shipping_addresses WHERE id = ${addressId}`);

    const r = await db.execute(sql`
      SELECT ship_to_line1, ship_to_city, ship_to_postal_code
      FROM commerce_orders WHERE id = ${orderId}`);
    const row = r.rows[0] as
      | { ship_to_line1: string; ship_to_city: string; ship_to_postal_code: string }
      | undefined;
    expect(row, "the order went with the address").toBeDefined();
    expect(row?.ship_to_line1).toBe("1 Test Way");
    expect(row?.ship_to_city).toBe("Portland");
    expect(row?.ship_to_postal_code).toBe("97201");
  });

  it("allows only one LIVE address per user, and any number of archived ones", async () => {
    const user = await createTestUser();
    await insertAddress(user.id);
    await expect(
      insertAddress(user.id),
      "a user was given two live shipping addresses",
    ).rejects.toThrow();

    // Archiving is what makes room for the new one. A non-partial unique index
    // would fail here too, and moving house would then require destroying the
    // address a past order shipped to.
    await db.execute(sql`
      UPDATE user_shipping_addresses SET archived_at = now() WHERE user_id = ${user.id}`);
    const second = await insertAddress(user.id);
    expect(second).toBeTruthy();
  });

  it("keeps status and fulfillment_state as varchar, not an enum", async () => {
    const types = await columnTypes("commerce_orders", ["status", "fulfillment_state"]);
    // A pgEnum reports as "USER-DEFINED" here, which is the failure this guards.
    expect(types).toEqual({ status: "character varying", fulfillment_state: "character varying" });
  });

  it("returns no rows for an unrecognised status instead of raising", async () => {
    // The behaviour the varchar choice exists for, asserted rather than
    // inferred from the type: an unknown enum literal in a WHERE clause is a
    // 500, not a query that matches nothing. If either column is ever converted
    // to an enum this throws.
    const r = await db.execute(sql`
      SELECT count(*)::int AS n FROM commerce_orders
      WHERE status = 'no_such_status' OR fulfillment_state = 'no_such_state'`);
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });

  it("stores every amount as integer cents", async () => {
    // store_listings.price is `real` and means play_credit minor units in one
    // caller and USD dollars in another (#269). Physical money is integer USD
    // cents in a column named for its unit, and a float would silently lose
    // fractions of a real dollar.
    expect(await columnTypes("commerce_orders", [
      "item_cents", "shipping_cents", "tax_cents", "total_cents",
    ])).toEqual({
      item_cents: "integer",
      shipping_cents: "integer",
      tax_cents: "integer",
      total_cents: "integer",
    });
    expect(await columnTypes("commerce_products", ["item_cents", "shipping_cents"])).toEqual({
      item_cents: "integer",
      shipping_cents: "integer",
    });
  });

  it("prices the sticker as 0027 corrected it, and publishes it only once it can ship", async () => {
    // This case used to assert 1564 and unpublished, which was the state 0026
    // seeded and NOT the state the chain leaves. 0027 corrected both, and it
    // was right to: 1564 was never an item price, it was the all-in retail
    // figure, so charging it alongside 509 shipping billed $20.73 for a sticker
    // priced at $15.64. The migration split it 1055 + 509 = 1564, and this
    // reads the migrations rather than the memory of them.
    const r = await db.execute(sql`
      SELECT item_cents, shipping_cents, published, printify_product_id,
             printify_variant_id, artifact_id, ship_to_countries
      FROM commerce_products WHERE sku = 'kax-sticker-3.5in'`);
    const row = r.rows[0] as {
      item_cents: number;
      shipping_cents: number;
      published: boolean;
      printify_product_id: string | null;
      printify_variant_id: string | null;
      artifact_id: number | null;
      ship_to_countries: string[];
    } | undefined;
    expect(row, "the sticker product was not seeded").toBeDefined();
    expect(row?.item_cents, "0027 repriced the item line to 1055").toBe(1055);
    expect(row?.shipping_cents).toBe(509);
    expect(
      (row?.item_cents ?? 0) + (row?.shipping_cents ?? 0),
      "the buyer pays the all-in figure the design fixed, once",
    ).toBe(1564);
    expect(row?.printify_product_id).toBe("6a81f8c84b2b4c5db504b97f");
    expect(row?.printify_variant_id, "0027 pinned the 3.5in square vinyl variant").toBe("65212");
    expect(row?.ship_to_countries).toEqual(["US"]);

    // Publication is CONDITIONAL in 0027, not unconditional, and the condition
    // is what this asserts: a product with no artwork cannot be quoted and one
    // with no variant cannot be fulfilled, so the migration publishes only once
    // both are set. On a database built from the migrations alone there is no
    // `artifacts` row to point at, so the sticker stays unpublished — and on one
    // that has the artwork it goes on sale. Asserting either literal would be
    // asserting which database you happened to run against.
    expect(
      row?.published,
      row?.artifact_id === null
        ? "a product with no artwork was put on sale"
        : "the artwork and variant are both wired and the product is still not on sale",
    ).toBe(row?.artifact_id !== null);
  });

  it("defaults a new order to pending_payment and unfulfilled", async () => {
    // The purchase path inserts the row BEFORE calling Stripe and names neither
    // state. A default of anything settled would mark an unpaid order paid.
    const user = await createTestUser();
    const ref = makeTestId("ref-defaults");
    await insertOrder(user.id, ref);
    const r = await db.execute(sql`
      SELECT status, fulfillment_state, tax_cents, currency
      FROM commerce_orders WHERE client_reference = ${ref}`);
    const row = r.rows[0] as {
      status: string; fulfillment_state: string; tax_cents: number; currency: string;
    } | undefined;
    expect(row?.status).toBe("pending_payment");
    expect(row?.fulfillment_state).toBe("unfulfilled");
    expect(row?.tax_cents).toBe(0);
    expect(row?.currency).toBe("usd");
  });
});
