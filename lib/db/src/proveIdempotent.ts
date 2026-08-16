/**
 * Prove a migration is re-runnable by RE-RUNNING IT, not by asserting that it is.
 *
 * #282's first acceptance criterion says migrate must succeed on a fresh
 * database and succeed again on a second run. A literal second invocation
 * proves nothing: `runMigrations` skips anything already in `schema_migrations`,
 * so it would report "up to date" without executing a single statement of the
 * file under test. `UNMARK_SAFE_MIGRATIONS` exists precisely to make the
 * re-execution possible, and until now nothing exercised it.
 *
 * The `ensureCriticalSchema` suite is not a substitute. It proves that a
 * hand-maintained COPY of the DDL is re-runnable; the migration file is a
 * separate text, and the two can drift.
 *
 * What is checked, beyond "it did not raise":
 *
 *   - the seeded sticker row survives with its price and its published flag
 *     intact, because the seed is `ON CONFLICT (sku) DO NOTHING` and a re-run
 *     that overwrote it would put a withdrawn product back on sale;
 *   - every existing `commerce_orders` row survives, because a re-run that
 *     dropped one would destroy the record of a charge Stripe already took.
 *
 * Run as `pnpm --filter @workspace/db run migrate:prove-idempotent`, after the
 * ordinary migrate step. Exits non-zero on any failure, so CI fails on it.
 */

import { pool } from "./index";
import { runMigrations, unmarkJournal, UNMARK_SAFE_MIGRATIONS } from "./migrate";

/** Migrations to unmark and re-execute. Every one must be re-run safe. */
const TARGETS = process.argv.slice(2);
const DEFAULT_TARGETS = ["0026_physical_commerce.sql"];

interface Snapshot {
  orderCount: number;
  sticker: { item_cents: number; shipping_cents: number; published: boolean } | null;
}

async function snapshot(): Promise<Snapshot> {
  const orders = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM commerce_orders");
  const sticker = await pool.query<Snapshot["sticker"] & object>(
    "SELECT item_cents, shipping_cents, published FROM commerce_products WHERE sku = $1",
    ["kax-sticker-3.5in"],
  );
  return {
    orderCount: Number(orders.rows[0]?.n ?? "0"),
    sticker: sticker.rows[0] ?? null,
  };
}

function fail(message: string): never {
  console.error(`idempotency proof FAILED: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function main(): Promise<void> {
  const targets = TARGETS.length > 0 ? TARGETS : DEFAULT_TARGETS;
  for (const t of targets) {
    if (!UNMARK_SAFE_MIGRATIONS.has(t)) {
      fail(`${t} is not in UNMARK_SAFE_MIGRATIONS, so it must not be re-run`);
    }
  }

  const before = await snapshot();
  if (before.sticker === null) fail("the sticker product was not seeded by the first run");

  const { unmarked, notJournaled } = await unmarkJournal(targets);
  if (notJournaled.length > 0) {
    fail(`not applied in the first place: ${notJournaled.join(", ")}`);
  }
  console.log(`unmarked: ${unmarked.join(", ")}`);

  const result = await runMigrations({ log: (m) => console.log(`  ${m}`) });
  for (const t of targets) {
    if (!result.applied.includes(t)) fail(`${t} was not re-executed`);
  }

  const after = await snapshot();
  if (after.sticker === null) fail("the sticker product disappeared on the second run");
  if (after.orderCount !== before.orderCount) {
    fail(`commerce_orders went from ${before.orderCount} to ${after.orderCount} rows`);
  }
  if (
    after.sticker.item_cents !== before.sticker.item_cents ||
    after.sticker.shipping_cents !== before.sticker.shipping_cents ||
    after.sticker.published !== before.sticker.published
  ) {
    fail("the re-run overwrote the seeded product instead of leaving it alone");
  }

  console.log(`idempotency proof PASSED for ${targets.join(", ")}`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    void pool.end();
    process.exit(1);
  });
