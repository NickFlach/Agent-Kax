/**
 * migrate.ts — minimal, idempotent SQL migration runner.
 *
 * Reads `lib/db/migrations/*.sql` in lexicographic order, tracks
 * applied ones in `schema_migrations`, and skips already-applied
 * entries. Safe to run on every boot or once-per-deploy.
 *
 * Why hand-rolled instead of drizzle-kit's migrate command?
 *   - The existing `*.sql` files are hand-written (not drizzle-generated)
 *     so they don't have the meta-journal drizzle-kit expects.
 *   - The runner needs to work the same way in CI, in a one-shot ops
 *     script, and (optionally, behind KAX_AUTO_MIGRATE=1) at api-server
 *     boot. A 60-line PG-only runner is easier to reason about than
 *     adopting drizzle-kit's full conventions retroactively.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./index";

const HERE = dirname(fileURLToPath(import.meta.url));

// When this module runs from source, `../migrations` (relative to
// lib/db/src) is correct. In the api-server esbuild bundle,
// `import.meta.url` is the bundle's own path under artifacts/api-server,
// so the relative hop lands on a directory that doesn't exist — which made
// boot auto-migrate ENOENT silently on every Replit deploy (and is why
// 0009_floor_prediction_kind never applied in prod). Resolve against the
// workspace cwd as a fallback, with an env override as the escape hatch.
const MIGRATIONS_DIR = (() => {
  // Walk upward from a starting dir looking for lib/db/migrations — covers
  // bundles running with cwd inside artifacts/<name> (dev workflow) as well
  // as the workspace root (deploy).
  const upward = (start: string): string[] => {
    const out: string[] = [];
    let dir = start;
    for (let i = 0; i < 6; i++) {
      out.push(resolve(dir, "lib/db/migrations"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return out;
  };
  const candidates = [
    process.env["KAX_MIGRATIONS_DIR"],
    resolve(HERE, "../migrations"),
    ...upward(process.cwd()),
    ...upward(HERE),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      // keep looking
    }
  }
  return candidates[1]!; // original behavior; errors surface at read time
})();

interface MigrationRow {
  filename: string;
  applied_at: Date;
}

async function ensureJournalTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}

async function listApplied(): Promise<Set<string>> {
  const res = await pool.query<MigrationRow>("SELECT filename FROM schema_migrations");
  return new Set(res.rows.map((r) => r.filename));
}

function listOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lex order; the leading 000N keeps this deterministic
}

/**
 * The captured starting schema. Every other migration is incremental on top of
 * it, and it is the only file that may be journaled without being executed —
 * see the note in runMigrations().
 */
export const BASELINE_MIGRATION = "0000_baseline.sql";

/**
 * Is the baseline schema already physically present in this database?
 *
 * The journal is NOT a reliable answer to that question, which is what broke
 * production deploys. `runMigrations` originally inferred "pre-existing schema"
 * from a non-empty journal — but prod's schema was historically managed with
 * `drizzle-kit push`, so it has every table and an EMPTY journal (that is the
 * exact situation `backfillJournal` below exists to repair). The guard
 * therefore did not fire, the baseline ran `CREATE TABLE` over live tables, and
 * because a migration failure is fatal under auto-migrate the deploy exited
 * instead of serving.
 *
 * Asking the database is the only answer that is true in all three states:
 * blank (no table, no journal), migrated (table + journal), and push-managed
 * (table, no journal).
 *
 * `users` is created by the baseline and by no later migration, so its presence
 * means "the baseline's work is already done here".
 */
async function baselineSchemaPresent(): Promise<boolean> {
  const res = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('public.users') IS NOT NULL AS present",
  );
  return res.rows[0]?.present === true;
}

/** Record a migration as applied without running it. */
async function journalWithoutApplying(filename: string): Promise<void> {
  await pool.query(
    "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
    [filename],
  );
}

async function applyOne(filename: string, log: (m: string) => void): Promise<void> {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, filename), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
    await client.query("COMMIT");
    log(`  ✓ ${filename}`);
  } catch (err) {
    // Guard the ROLLBACK against masking the real error: if the connection
    // dropped mid-migration the ROLLBACK itself will throw, discarding the
    // original failure and replacing it with a generic "connection terminated".
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/** On-disk migration filenames in apply order. */
export function listMigrationFiles(): string[] {
  return listOnDisk();
}

/** Filenames currently recorded in the journal. */
export async function listAppliedMigrations(): Promise<string[]> {
  await ensureJournalTable();
  return [...(await listApplied())].sort();
}

/**
 * Mark migrations as applied WITHOUT executing them. Recovery tool for the
 * prod journal: the schema there was historically managed via drizzle-push,
 * so it is already past most migrations, but the empty journal makes the
 * boot runner re-attempt everything and die at the first non-idempotent
 * file (0003) — which blocks genuinely-pending migrations (0009+) forever.
 * Backfilling the already-in-effect files unblocks the runner.
 *
 * Only filenames that exist on disk are accepted; unknown names throw
 * before anything is written.
 */
export async function backfillJournal(filenames: string[]): Promise<{ journaled: string[]; alreadyJournaled: string[] }> {
  const onDisk = new Set(listOnDisk());
  const unknown = filenames.filter((f) => !onDisk.has(f));
  if (unknown.length > 0) {
    throw new Error(`Unknown migration file(s): ${unknown.join(", ")}`);
  }
  await ensureJournalTable();
  const applied = await listApplied();
  const journaled: string[] = [];
  const alreadyJournaled: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const f of filenames) {
      if (applied.has(f)) {
        alreadyJournaled.push(f);
        continue;
      }
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
        [f],
      );
      journaled.push(f);
    }
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
  return { journaled, alreadyJournaled };
}

/**
 * Remove journal rows WITHOUT touching the schema, so `runMigrations` will
 * re-execute those files. Recovery tool for the opposite failure of
 * `backfillJournal`: a journal row exists but the migration's effect is
 * missing (the prod journal was over-backfilled in July 2026 — 0011/0015/0016
 * were journaled but never executed, so the harvester 500'd on the missing
 * `partner_sync_state.event_cursors` column). Only use for migrations that
 * are safe to re-run (IF NOT EXISTS / OR REPLACE); unknown filenames throw.
 *
 * Guarded by an explicit allowlist: only migrations vetted as fully
 * idempotent may be unmarked. The baseline (unguarded CREATE TABLE) and
 * 0003 (enum rename, non-idempotent) must never be re-run against a live
 * database, so they are deliberately absent.
 */
export const UNMARK_SAFE_MIGRATIONS: ReadonlySet<string> = new Set([
  "0009_floor_prediction_kind.sql",
  "0010_password_reset.sql",
  "0011_store_listings.sql",
  "0012_floor_ledger_append_only.sql",
  "0013_credit_ledger.sql",
  "0014_credit_ledger_txids.sql",
  "0015_agent_npub.sql",
  "0016_partner_event_cursors.sql",
  "0025_stripe_listing_orders.sql",
  "0026_physical_commerce.sql",
  "0027_publish_the_first_sticker.sql",
  // Both are ALTER ... ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
  // and nothing else, so re-running either is a no-op on a healthy database.
  // They are listed because this exact recovery was needed once: a
  // `drizzle-kit push` dropped 0028's columns from production, and with 0028
  // already journaled there was no migration path back.
  "0028_fulfillment_worker_state.sql",
  "0029_restore_fulfillment_worker_columns.sql",
]);

export async function unmarkJournal(filenames: string[]): Promise<{ unmarked: string[]; notJournaled: string[] }> {
  const onDisk = new Set(listOnDisk());
  const unknown = filenames.filter((f) => !onDisk.has(f));
  if (unknown.length > 0) {
    throw new Error(`Unknown migration file(s): ${unknown.join(", ")}`);
  }
  const unsafe = filenames.filter((f) => !UNMARK_SAFE_MIGRATIONS.has(f));
  if (unsafe.length > 0) {
    throw new Error(
      `Not vetted as safe to re-run: ${unsafe.join(", ")}. Add to UNMARK_SAFE_MIGRATIONS only after confirming the migration is fully idempotent.`,
    );
  }
  await ensureJournalTable();
  const applied = await listApplied();
  const unmarked: string[] = [];
  const notJournaled: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const f of filenames) {
      if (!applied.has(f)) {
        notJournaled.push(f);
        continue;
      }
      await client.query("DELETE FROM schema_migrations WHERE filename = $1", [f]);
      unmarked.push(f);
    }
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
  return { unmarked, notJournaled };
}

/** Run all pending migrations. Returns which were applied vs already-applied. */
export async function runMigrations(opts: { log?: (m: string) => void } = {}): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  await ensureJournalTable();
  const applied = await listApplied();
  const onDisk = listOnDisk();
  const pending = onDisk.filter((f) => !applied.has(f));
  const skipped = onDisk.filter((f) => applied.has(f));

  if (pending.length === 0) {
    log(`schema_migrations: up to date (${skipped.length} already applied)`);
    return { applied: [], skipped };
  }

  // A database that already HAS the baseline's tables must not run the
  // baseline again — `CREATE TABLE` over live tables fails the whole run, and
  // under auto-migrate a migration failure is fatal, so the deploy exits
  // instead of serving.
  //
  // This originally tested `applied.size > 0`, i.e. it inferred "schema exists"
  // from "journal is non-empty". That is wrong for the one database that
  // matters: prod's schema was built with `drizzle-kit push`, so it has every
  // table and an EMPTY journal, and the guard silently did not fire. Ask the
  // database directly instead — that is correct for a blank database (no
  // table ⇒ apply for real), a migrated one, and a push-managed one alike.
  //
  // The journal check is kept as a cheap short-circuit so the common case
  // costs no extra query.
  const baselinePending = pending.includes(BASELINE_MIGRATION);
  const baselineAlreadyDone =
    baselinePending && (applied.size > 0 || (await baselineSchemaPresent()));

  const toApply: string[] = [];
  for (const f of pending) {
    if (f === BASELINE_MIGRATION && baselineAlreadyDone) {
      await journalWithoutApplying(f);
      log(`  = ${f} (pre-existing schema — recorded, not executed)`);
      skipped.push(f);
      continue;
    }
    toApply.push(f);
  }

  if (toApply.length === 0) {
    log(`schema_migrations: up to date (${skipped.length} already applied)`);
    return { applied: [], skipped };
  }

  log(`schema_migrations: applying ${toApply.length} new migration(s)`);
  for (const f of toApply) {
    await applyOne(f, log);
  }

  return { applied: toApply, skipped };
}

// CLI mode — `pnpm db:migrate` runs this directly. The `basename` guard is
// load-bearing: this module is re-exported from `./index` and gets bundled
// into other artifacts (e.g. the api-server esbuild bundle). In that case
// `import.meta.url` is the bundle URL and equals `process.argv[1]`, which
// would otherwise trip this branch on every boot and call `pool.query`
// before the pool finishes initializing. Restricting to "the running script
// is literally migrate.{ts,mjs}" keeps the CLI path working while making
// the bundled path a no-op.
const argv1 = process.argv[1] ?? "";
const isMain =
  (import.meta.url === `file://${argv1}` ||
    import.meta.url === `file:///${argv1.replace(/\\/g, "/")}`) &&
  /(^|[\\/])migrate\.(?:ts|mjs|js)$/.test(argv1);
if (isMain) {
  runMigrations({ log: (m) => console.log(m) })
    .then((r) => {
      console.log(`migrations: ${r.applied.length} applied, ${r.skipped.length} skipped`);
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      void pool.end();
      process.exit(1);
    });
}
