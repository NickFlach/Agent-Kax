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
  const candidates = [
    process.env["KAX_MIGRATIONS_DIR"],
    resolve(HERE, "../migrations"),
    resolve(process.cwd(), "lib/db/migrations"),
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
    await client.query("ROLLBACK");
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
  for (const f of filenames) {
    if (applied.has(f)) {
      alreadyJournaled.push(f);
      continue;
    }
    await pool.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
      [f],
    );
    journaled.push(f);
  }
  return { journaled, alreadyJournaled };
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

  log(`schema_migrations: applying ${pending.length} new migration(s)`);
  for (const f of pending) {
    await applyOne(f, log);
  }

  return { applied: pending, skipped };
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
