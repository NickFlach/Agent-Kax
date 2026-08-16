/**
 * ensureCriticalSchema.test.ts — it has to rebuild a table that is really gone.
 *
 * The deploy's schema diff drops `residence_units` on every publish, and
 * migrations cannot help because an applied migration never re-runs. This step
 * is the thing standing between that and a dead endpoint, so the test drops the
 * table for real and requires it back, seeded, with its indexes.
 *
 * Every table this file protects gets the same treatment — dropped for real,
 * then required back usable rather than merely present, because a rebuilt table
 * that has lost its constraints or its defaults is a different table wearing
 * the same name.
 */

import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { artifactsTable, storeListingsTable } from "@workspace/db/schema";
import { cleanupTestData, createTestAgent, createTestUser, makeTestId } from "../test-helpers";
import { ensureCriticalSchema } from "./ensureCriticalSchema";

async function unitCount(): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM residence_units`);
  return (r.rows[0] as { n: number }).n;
}

/**
 * A listing with real parents behind it, so an order row can actually be
 * inserted against it. A rebuilt `listing_orders` that merely EXISTS proves
 * nothing — its foreign keys point at `store_listings` and `users`, and only a
 * genuine row exercises them.
 */
async function seedListing(): Promise<{ listingId: number; buyerUserId: string; artifactId: number }> {
  const owner = await createTestUser();
  const seller = await createTestAgent(owner.id, "listing-orders-seller");
  const [artifact] = await db
    .insert(artifactsTable)
    .values({
      externalId: makeTestId("listing-orders-art"),
      title: "Order Test Piece",
      creatorName: "Selfheal",
      publicUrl: "https://example.invalid/piece",
      artifactType: "furniture",
    })
    .returning({ id: artifactsTable.id });
  const [listing] = await db
    .insert(storeListingsTable)
    .values({ storeAgentId: seller.id, artifactId: artifact!.id, price: 4.2 })
    .returning({ id: storeListingsTable.id });
  return { listingId: listing!.id, buyerUserId: owner.id, artifactId: artifact!.id };
}

/** The five tables migration 0026 adds, in the order STATEMENTS rebuilds them. */
const COMMERCE_TABLES = [
  "user_shipping_addresses",
  "user_payment_methods",
  "user_purchasing_consents",
  "commerce_products",
  "commerce_orders",
] as const;

/**
 * An order written the way the purchase path writes one: address values copied
 * in as literals, and neither state column named so the table's own defaults
 * decide them.
 */
async function insertCommerceOrder(userId: string, clientReference: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO commerce_orders
      (client_reference, buyer_user_id, sku, item_cents, shipping_cents, total_cents,
       ship_to_name, ship_to_line1, ship_to_city, ship_to_region, ship_to_postal_code,
       ship_to_country)
    VALUES (${clientReference}, ${userId}, 'kax-sticker-3.5in', 1564, 509, 2073,
            'Test Buyer', '1 Test Way', 'Portland', 'OR', '97201', 'US')`);
}

async function dropSeededListing(artifactId: number): Promise<void> {
  // The artifact is the root of the chain: listings cascade from it and orders
  // cascade from the listing, so one delete takes the whole fixture. Nothing
  // here touches credit_ledger, which is append-only.
  await db.delete(artifactsTable).where(eq(artifactsTable.id, artifactId));
  await cleanupTestData();
}

describe("ensureCriticalSchema", () => {
  afterAll(async () => { await ensureCriticalSchema(); });

  it("is a no-op when everything is present", async () => {
    await ensureCriticalSchema();
    const before = await unitCount();
    const r = await ensureCriticalSchema();
    expect(r.error).toBeUndefined();
    expect(r.repaired).toBe(false);
    expect(await unitCount()).toBe(before); // seed must not duplicate
  });

  it("rebuilds and re-seeds a table that has been dropped", async () => {
    await db.execute(sql`DROP TABLE IF EXISTS residence_units`);
    const r = await ensureCriticalSchema();
    expect(r.error).toBeUndefined();
    expect(r.repaired).toBe(true);
    expect(r.unitsAfter).toBe(80);
  });

  it("puts city_residents back when the deploy eats it", async () => {
    // Not hypothetical. The deploy of 2026-08-15 dropped exactly this table:
    // boot self-check reported 25 tables checked, missingTables
    // ['city_residents'], everything else intact — and migration 0021 had
    // already recorded itself, so nothing would ever have replaced it.
    // Residencies then cannot survive a restart, which is the whole feature.
    await db.execute(sql`DROP TABLE IF EXISTS city_residents`);
    await ensureCriticalSchema();

    const probe = await db.execute(sql`SELECT to_regclass('public.city_residents') AS t`);
    expect((probe.rows[0] as { t: string | null }).t).not.toBeNull();

    // And it comes back usable, not just present.
    await db.execute(sql`
      INSERT INTO city_residents (principal, name, kind, room)
      VALUES ('kax:agent:selfheal', 'Selfheal', 'agent', 'city')
      ON CONFLICT (principal) DO NOTHING`);
    const row = await db.execute(sql`SELECT room FROM city_residents WHERE principal = 'kax:agent:selfheal'`);
    expect((row.rows[0] as { room: string }).room).toBe("city");
    await db.execute(sql`DELETE FROM city_residents WHERE principal = 'kax:agent:selfheal'`);
  });

  it("puts back COLUMNS the diff deletes, not just tables", async () => {
    // The 2026-08-15 deploy diff proposed dropping bsky_handle and
    // bsky_verified_at "with 2 items" — data and all — because a stale build
    // did not declare them. Restoring tables alone would have left user_bots
    // unable to record a proven link, with nothing to say why.
    await db.execute(sql`ALTER TABLE user_bots DROP COLUMN IF EXISTS bsky_handle`);
    await db.execute(sql`ALTER TABLE user_bots DROP COLUMN IF EXISTS bsky_verified_at`);

    await ensureCriticalSchema();

    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_bots' AND column_name IN ('bsky_handle','bsky_verified_at')`);
    expect(cols.rows.map((r) => (r as { column_name: string }).column_name).sort())
      .toEqual(["bsky_handle", "bsky_verified_at"]);
  });

  it("restores the enum VALUE without recreating the type", async () => {
    // Recreating the type is the destructive move the diff wanted: it rewrites
    // the column and cannot survive a row already carrying the value being
    // removed. Adding the value back is additive.
    await ensureCriticalSchema();
    const vals = await db.execute(sql`
      SELECT unnest(enum_range(NULL::auth_challenge_kind))::text AS v`);
    const names = vals.rows.map((r) => (r as { v: string }).v);
    expect(names).toContain("bsky_bind_challenge");
    // The pre-existing values must still be there — a recreate would have
    // silently changed what the column can hold.
    expect(names).toContain("npub_bind_challenge");
    expect(names).toContain("wallet_nonce");
  });

  it("is a no-op for city_residents when it is already there", async () => {
    await ensureCriticalSchema();
    await db.execute(sql`
      INSERT INTO city_residents (principal, name, kind, room)
      VALUES ('kax:agent:keepme', 'Keepme', 'agent', 'cafe')
      ON CONFLICT (principal) DO NOTHING`);
    // A repair that DROPPED anything would take live residencies with it.
    await ensureCriticalSchema();
    const row = await db.execute(sql`SELECT room FROM city_residents WHERE principal = 'kax:agent:keepme'`);
    expect((row.rows[0] as { room: string })?.room).toBe("cafe");
    await db.execute(sql`DELETE FROM city_residents WHERE principal = 'kax:agent:keepme'`);
  });

  it("does not take the city's furniture with it when residence_units is dropped", async () => {
    // The reason unit_furnishings holds an ADDRESS and has no foreign key to
    // residence_units. A foreign key would make the drop this file exists to
    // repair cascade through every purchase in the city, and the rebuild
    // re-seeds serial ids that a surviving unit_id would misread as somebody
    // else's flat. Both failures are silent — the money is gone and the room
    // is either empty or holds a stranger's chair.
    await ensureCriticalSchema();
    await db.execute(sql`
      INSERT INTO unit_furnishings (floor, letter, artifact_id, slot, price_paid, tx_id)
      SELECT 11, 'H', a.id, 'corner', 1000, 'test:selfheal'
      FROM artifacts a LIMIT 1
      ON CONFLICT DO NOTHING`);
    const seeded = await db.execute(sql`SELECT count(*)::int AS n FROM unit_furnishings WHERE tx_id = 'test:selfheal'`);
    const had = (seeded.rows[0] as { n: number }).n;

    await db.execute(sql`DROP TABLE IF EXISTS residence_units`);
    await ensureCriticalSchema();

    const after = await db.execute(sql`SELECT count(*)::int AS n FROM unit_furnishings WHERE tx_id = 'test:selfheal'`);
    expect((after.rows[0] as { n: number }).n, "the drop cascaded through the furniture").toBe(had);
    await db.execute(sql`DELETE FROM unit_furnishings WHERE tx_id = 'test:selfheal'`);
  });

  it("restores the uniqueness rules, not just the rows", async () => {
    await ensureCriticalSchema();
    // A duplicate door must still be impossible after a rebuild.
    await expect(
      db.execute(sql`INSERT INTO residence_units (floor, letter, tier) VALUES (5, 'A', 2)`),
    ).rejects.toThrow();
  });

  it("puts listing_orders back when the deploy eats it", async () => {
    // The newest table, in exactly the two-of-three state residence_units was
    // in the day it first went: migration 0025 wrote it, the schema barrel
    // exports it, and nothing rebuilt it at boot. `repaired` is not the
    // assertion here — it reports on residence_units alone — so the probe and a
    // real insert are what say the table came back.
    await ensureCriticalSchema();
    const seed = await seedListing();
    try {
      await db.execute(sql`DROP TABLE IF EXISTS listing_orders`);
      const r = await ensureCriticalSchema();
      expect(r.error).toBeUndefined();

      const probe = await db.execute(sql`SELECT to_regclass('public.listing_orders') AS t`);
      expect((probe.rows[0] as { t: string | null }).t).not.toBeNull();

      // It has to come back usable, with 0025's defaults intact: checkout
      // inserts an order without naming currency or status and reads the
      // pending row back.
      const sessionId = makeTestId("cs-rebuilt");
      await db.execute(sql`
        INSERT INTO listing_orders (listing_id, buyer_user_id, stripe_session_id, amount_cents)
        VALUES (${seed.listingId}, ${seed.buyerUserId}, ${sessionId}, 420)`);
      const row = await db.execute(sql`
        SELECT currency, status FROM listing_orders WHERE stripe_session_id = ${sessionId}`);
      const order = row.rows[0] as { currency: string; status: string } | undefined;
      expect(order?.currency).toBe("usd");
      expect(order?.status).toBe("pending");

      // And a second pass must leave that order alone — a repair that dropped
      // anything would destroy the record of a purchase Stripe already took
      // money for.
      await ensureCriticalSchema();
      const survived = await db.execute(sql`
        SELECT count(*)::int AS n FROM listing_orders WHERE stripe_session_id = ${sessionId}`);
      expect((survived.rows[0] as { n: number }).n, "the repair dropped a paid order").toBe(1);
    } finally {
      await dropSeededListing(seed.artifactId);
    }
  });

  it("rebuilds listing_orders with its constraints, not a lookalike", async () => {
    // Copying the shape out of the drizzle schema instead of 0025 would give a
    // table that exists and accepts rows the real one refuses — an order
    // pointing at no listing, or two orders claiming the same Checkout Session,
    // which is how the confirm path identifies a payment.
    await db.execute(sql`DROP TABLE IF EXISTS listing_orders`);
    await ensureCriticalSchema();
    const seed = await seedListing();
    try {
      const sessionId = makeTestId("cs-constraints");
      await db.execute(sql`
        INSERT INTO listing_orders (listing_id, buyer_user_id, stripe_session_id, amount_cents)
        VALUES (${seed.listingId}, ${seed.buyerUserId}, ${sessionId}, 100)`);

      await expect(
        db.execute(sql`
          INSERT INTO listing_orders (listing_id, buyer_user_id, stripe_session_id, amount_cents)
          VALUES (${seed.listingId}, ${seed.buyerUserId}, ${sessionId}, 100)`),
        "a second order reused a Checkout Session id",
      ).rejects.toThrow();

      await expect(
        db.execute(sql`
          INSERT INTO listing_orders (listing_id, buyer_user_id, stripe_session_id, amount_cents)
          VALUES (-1, ${seed.buyerUserId}, ${makeTestId("cs-orphan")}, 100)`),
        "an order was accepted for a listing that does not exist",
      ).rejects.toThrow();

      // The second foreign key, which every other insert in this file only
      // ever satisfies. A rebuilt table that has lost it still passes the two
      // checks above while accepting a paid order attributed to nobody, and
      // the confirm path has no way to hand that purchase to anyone.
      await expect(
        db.execute(sql`
          INSERT INTO listing_orders (listing_id, buyer_user_id, stripe_session_id, amount_cents)
          VALUES (${seed.listingId}, 'kax-test-no-such-user', ${makeTestId("cs-orphan-buyer")}, 100)`),
        "an order was accepted for a buyer that does not exist",
      ).rejects.toThrow();
    } finally {
      await dropSeededListing(seed.artifactId);
    }
  });

  it("brings listing_orders' indexes back with it", async () => {
    // Both lookups the store makes — a buyer's purchases, a listing's orders —
    // are unindexed scans without these, and an index that only ever existed
    // because a migration ran once does not survive the table being dropped.
    await db.execute(sql`DROP TABLE IF EXISTS listing_orders`);
    await ensureCriticalSchema();

    const idx = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'listing_orders'`);
    const names = idx.rows.map((r) => (r as { indexname: string }).indexname);
    expect(names).toContain("listing_orders_buyer_idx");
    expect(names).toContain("listing_orders_listing_idx");
  });

  it("puts back the store_listings columns 0025 added, not just its table", async () => {
    // The diff eats columns as readily as tables (bsky_handle above is the
    // proof), and these two are where a listing remembers the Stripe Product
    // and Price it already created. Losing them mints a duplicate pair on every
    // purchase rather than raising anything anyone would see.
    await db.execute(sql`ALTER TABLE store_listings DROP COLUMN IF EXISTS stripe_product_id`);
    await db.execute(sql`ALTER TABLE store_listings DROP COLUMN IF EXISTS stripe_price_id`);

    await ensureCriticalSchema();

    const cols = await db.execute(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'store_listings'
        AND column_name IN ('stripe_product_id','stripe_price_id')`);
    expect(cols.rows.map((r) => (r as { column_name: string }).column_name).sort())
      .toEqual(["stripe_price_id", "stripe_product_id"]);
    // TEXT in 0025 — a varchar with a length would truncate a Stripe id.
    expect(cols.rows.map((r) => (r as { data_type: string }).data_type))
      .toEqual(["text", "text"]);
  });

  it("puts every physical-commerce table back when the deploy eats them", async () => {
    // All five at once, because the deploy diff has never taken only one thing
    // and the repair loop stops at the first statement that raises — so a
    // statement ordered behind something that is itself missing shows up here
    // and nowhere else.
    for (const t of COMMERCE_TABLES) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${t}`));
    }
    const r = await ensureCriticalSchema();
    expect(r.error).toBeUndefined();

    for (const t of COMMERCE_TABLES) {
      const probe = await db.execute(sql.raw(`SELECT to_regclass('public.${t}') AS t`));
      expect((probe.rows[0] as { t: string | null }).t, `${t} was not rebuilt`).not.toBeNull();
    }
  });

  it("rebuilds commerce_orders usable, with 0026's defaults and its unique key", async () => {
    // Present is not enough. The purchase path inserts the row before calling
    // Stripe, naming neither status nor fulfilment state, and relies on the
    // unique client_reference to turn a retry into a read instead of a second
    // charge. A rebuilt table that has lost either is a lookalike that takes
    // money twice.
    await db.execute(sql`DROP TABLE IF EXISTS commerce_orders`);
    await ensureCriticalSchema();

    const user = await createTestUser();
    try {
      const ref = makeTestId("commerce-ref");
      await insertCommerceOrder(user.id, ref);
      const row = await db.execute(sql`
        SELECT status, fulfillment_state, currency, tax_cents
        FROM commerce_orders WHERE client_reference = ${ref}`);
      const order = row.rows[0] as {
        status: string; fulfillment_state: string; currency: string; tax_cents: number;
      } | undefined;
      expect(order?.status).toBe("pending_payment");
      expect(order?.fulfillment_state).toBe("unfulfilled");
      expect(order?.currency).toBe("usd");
      expect(order?.tax_cents).toBe(0);

      await expect(
        insertCommerceOrder(user.id, ref),
        "the rebuilt table lost the client_reference unique key",
      ).rejects.toThrow();

      // A second pass must leave the order alone — a repair that dropped
      // anything would destroy the record of a charge Stripe already took.
      await ensureCriticalSchema();
      const survived = await db.execute(sql`
        SELECT count(*)::int AS n FROM commerce_orders WHERE client_reference = ${ref}`);
      expect((survived.rows[0] as { n: number }).n, "the repair dropped a paid order").toBe(1);
    } finally {
      await cleanupTestData();
    }
  });

  it("brings the commerce indexes back with the tables", async () => {
    // The webhook finds an order by PaymentIntent, the buyer's history reads by
    // user, and the stuck-`authenticating` sweep reads by state and age. All
    // three are sequential scans over every order ever placed without these,
    // and an index that exists only because a migration ran once does not
    // survive its table being dropped.
    await db.execute(sql`DROP TABLE IF EXISTS commerce_orders`);
    await db.execute(sql`DROP TABLE IF EXISTS user_shipping_addresses`);
    await ensureCriticalSchema();

    const idx = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('commerce_orders','user_shipping_addresses')`);
    const names = idx.rows.map((r) => (r as { indexname: string }).indexname);
    expect(names).toContain("commerce_orders_buyer_idx");
    expect(names).toContain("commerce_orders_payment_intent_idx");
    expect(names).toContain("commerce_orders_status_idx");
    expect(names).toContain("user_shipping_addresses_user_idx");
    // Partial, and the partiality is the constraint: one LIVE address per user
    // while the archived history stays unconstrained.
    expect(names).toContain("user_shipping_addresses_live_unique");
  });

  it("re-seeds the sticker product, and never re-publishes one taken down", async () => {
    // A rebuilt commerce_products that came back empty is a shop that is simply
    // shut, with no error to say why — the quote path would have nothing to
    // read. But the seed must also never overwrite an operator's decision: the
    // row ships unpublished, and unpublishing it is how a product is withdrawn.
    await db.execute(sql`DROP TABLE IF EXISTS commerce_products`);
    await ensureCriticalSchema();

    const seeded = await db.execute(sql`
      SELECT item_cents, shipping_cents, published
      FROM commerce_products WHERE sku = 'kax-sticker-3.5in'`);
    const row = seeded.rows[0] as
      | { item_cents: number; shipping_cents: number; published: boolean }
      | undefined;
    expect(row, "the sticker product was not re-seeded").toBeDefined();
    expect(row?.item_cents).toBe(1564);
    expect(row?.shipping_cents).toBe(509);
    expect(row?.published).toBe(false);

    // try/finally, not a trailing statement. An assertion that throws between
    // the edit and the restore would leave 999 in the database for the rest of
    // the run AND the next one, where commerceSchema.test.ts's "seeds the
    // sticker unpublished, at the price the design fixed" asserts 1564 — a
    // cascading false failure in a file that changed nothing.
    try {
      await db.execute(sql`
        UPDATE commerce_products SET item_cents = 999 WHERE sku = 'kax-sticker-3.5in'`);
      await ensureCriticalSchema();
      const afterEdit = await db.execute(sql`
        SELECT item_cents FROM commerce_products WHERE sku = 'kax-sticker-3.5in'`);
      expect(
        (afterEdit.rows[0] as { item_cents: number }).item_cents,
        "the seed overwrote a price somebody set",
      ).toBe(999);
    } finally {
      await db.execute(sql`
        UPDATE commerce_products SET item_cents = 1564 WHERE sku = 'kax-sticker-3.5in'`);
    }

    // The case the name promises, and which nothing tested: publishing is the
    // operator's decision in both directions. A seed that re-published a
    // product somebody took down would put a withdrawn item back on sale on the
    // next boot, and a seed that unpublished a live one would silently shut the
    // shop.
    try {
      await db.execute(sql`
        UPDATE commerce_products SET published = true WHERE sku = 'kax-sticker-3.5in'`);
      await ensureCriticalSchema();
      const stillUp = await db.execute(sql`
        SELECT published FROM commerce_products WHERE sku = 'kax-sticker-3.5in'`);
      expect(
        (stillUp.rows[0] as { published: boolean }).published,
        "the seed unpublished a product an operator had put on sale",
      ).toBe(true);

      await db.execute(sql`
        UPDATE commerce_products SET published = false WHERE sku = 'kax-sticker-3.5in'`);
      await ensureCriticalSchema();
      const stillDown = await db.execute(sql`
        SELECT published FROM commerce_products WHERE sku = 'kax-sticker-3.5in'`);
      expect(
        (stillDown.rows[0] as { published: boolean }).published,
        "the seed re-published a product an operator had taken down",
      ).toBe(false);
    } finally {
      await db.execute(sql`
        UPDATE commerce_products SET published = false WHERE sku = 'kax-sticker-3.5in'`);
    }
  });

  it("puts users.stripe_customer_id back when the diff deletes the column", async () => {
    // Losing this does not raise: the settings endpoint would find no customer,
    // create a second one at Stripe, and the same human would end up with two
    // payment histories and a saved card attached to whichever came first.
    await db.execute(sql`DROP INDEX IF EXISTS users_stripe_customer_id_unique`);
    await db.execute(sql`ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id`);

    await ensureCriticalSchema();

    const cols = await db.execute(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'stripe_customer_id'`);
    expect((cols.rows[0] as { data_type: string } | undefined)?.data_type).toBe("text");
    const idx = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'users'`);
    expect(idx.rows.map((r) => (r as { indexname: string }).indexname))
      .toContain("users_stripe_customer_id_unique");
  });
});
