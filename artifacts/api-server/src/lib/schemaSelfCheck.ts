import { sql, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { db } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { logger } from "./logger";

/**
 * Does the database actually look like the schema the code queries?
 *
 * `GET /residences/units` went dark in production and reported nothing but
 * "Internal server error" — the table had lost structure, every other endpoint
 * was healthy, and CI passed the same query, so it took three deploy cycles to
 * find (#191). A boot-time check would have named it in the first log line.
 *
 * The expectation is DERIVED from the drizzle schema rather than hand-listed,
 * so it cannot drift from what the application actually reads. Add a table to
 * the schema and it is checked automatically; a hand-maintained list would go
 * stale the first busy week and then quietly stop protecting anything.
 *
 * This never throws and never blocks the boot. A server that is up and loudly
 * complaining is more useful than one that refuses to start — and migrations
 * already own the fatal path.
 */

export interface SchemaCheckResult {
  ok: boolean;
  checkedTables: number;
  missingTables: string[];
  /** "table.column" for columns the schema expects and the database lacks. */
  missingColumns: string[];
  /** Set when the check itself could not run (no DB, permissions, etc.). */
  error?: string;
}

/** Every pgTable exported from the schema barrel, with its expected columns. */
function expectedShape(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value as PgTable);
    out.set(cfg.name, new Set(cfg.columns.map((c) => c.name)));
  }
  return out;
}

export async function checkSchema(): Promise<SchemaCheckResult> {
  const expected = expectedShape();
  const names = [...expected.keys()];
  if (names.length === 0) {
    return { ok: true, checkedTables: 0, missingTables: [], missingColumns: [] };
  }

  let rows: Array<{ table_name: string; column_name: string }>;
  try {
    const res = await db.execute(
      sql`SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'`,
    );
    rows = res.rows as Array<{ table_name: string; column_name: string }>;
  } catch (e) {
    const err = e as { message?: string };
    return {
      ok: false,
      checkedTables: names.length,
      missingTables: [],
      missingColumns: [],
      error: err.message ?? "schema introspection failed",
    };
  }

  const actual = new Map<string, Set<string>>();
  for (const r of rows) {
    let cols = actual.get(r.table_name);
    if (!cols) { cols = new Set(); actual.set(r.table_name, cols); }
    cols.add(r.column_name);
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  for (const [table, cols] of expected) {
    const present = actual.get(table);
    if (!present) { missingTables.push(table); continue; }
    for (const col of cols) {
      if (!present.has(col)) missingColumns.push(`${table}.${col}`);
    }
  }

  return {
    ok: missingTables.length === 0 && missingColumns.length === 0,
    checkedTables: names.length,
    missingTables: missingTables.sort(),
    missingColumns: missingColumns.sort(),
  };
}

/**
 * Run the check and say so in one line. Called after migrations at boot; the
 * failure log is deliberately shaped to be greppable and to name the fix.
 */
export async function reportSchemaAtBoot(): Promise<SchemaCheckResult> {
  const result = await checkSchema();
  if (result.error) {
    logger.error({ error: result.error }, "schema self-check could not run");
    return result;
  }
  if (result.ok) {
    logger.info({ tables: result.checkedTables }, "schema self-check: database matches the schema");
    return result;
  }
  logger.error(
    {
      missingTables: result.missingTables,
      missingColumns: result.missingColumns,
      checkedTables: result.checkedTables,
    },
    "SCHEMA MISMATCH — the database is missing structure the code queries; " +
      "endpoints touching these will 500. Add an idempotent repair migration " +
      "(an already-applied migration will never re-run).",
  );
  return result;
}
