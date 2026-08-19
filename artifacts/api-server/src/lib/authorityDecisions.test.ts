/**
 * authorityDecisions.test.ts — #247's acceptance criteria for the DARK
 * decision record (KAX-ADR-0001 Phase 1a).
 *
 * The table has no writers yet, on purpose — the last test proves that with a
 * source grep, so the day a writer lands it must also update the expectation
 * there (and it should: #248 is that writer, and this pin is how the review
 * notices it arrived).
 *
 * DB-backed; runs in CI against the migration-chain Postgres.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { authorityDecisionsTable } from "@workspace/db/schema";
import { ensureCriticalSchema } from "./ensureCriticalSchema";

const uniq = () => Math.random().toString(36).slice(2, 10);

async function insertDecision(decisionId: string): Promise<void> {
  await db.insert(authorityDecisionsTable).values({
    decisionId,
    actor: `kax:agent:test-${uniq()}`,
    capability: "test.capability",
    decision: "allow",
    reasonCode: "test_fixture",
  });
}

describe("authority_decisions (#247, DB)", () => {
  it("comes back after being dropped, via ensureCriticalSchema", async () => {
    await db.execute(sql`DROP TABLE IF EXISTS authority_decisions CASCADE`);
    const r = await ensureCriticalSchema();
    expect(r.repaired).toBe(true);
    // And it is genuinely usable again, trigger included.
    await insertDecision(`dec-${uniq()}`);
    const again = await ensureCriticalSchema();
    expect(again.repaired).toBe(false);
  });

  it("rejects UPDATE at the database level", async () => {
    const id = `dec-${uniq()}`;
    await insertDecision(id);
    const err = await db
      .execute(sql`UPDATE authority_decisions SET decision = 'deny' WHERE decision_id = ${id}`)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err, "the append-only trigger did not reject the UPDATE").not.toBe(null);
    // drizzle rewrites the top-level message to "Failed query: …"; the
    // trigger's RAISE text lands on err.cause.
    const cause = (err as { cause?: { message?: string } })?.cause;
    expect(`${cause?.message ?? ""}${(err as Error)?.message ?? ""}`).toMatch(/append-only/);
  });

  it("rejects DELETE at the database level", async () => {
    const id = `dec-${uniq()}`;
    await insertDecision(id);
    const err = await db
      .execute(sql`DELETE FROM authority_decisions WHERE decision_id = ${id}`)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err, "the append-only trigger did not reject the DELETE").not.toBe(null);
    const cause = (err as { cause?: { message?: string } })?.cause;
    expect(`${cause?.message ?? ""}${(err as Error)?.message ?? ""}`).toMatch(/append-only/);
  });

  it("has zero non-test writers — the table is dark until #248", () => {
    // Source-level ON PURPOSE, and only as the dark-ness pin (the behavioural
    // properties above are behavioural): walk production sources for inserts
    // into the table by either its drizzle identifier or its SQL name.
    const SRC = path.join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const src = fs.readFileSync(full, "utf8");
          if (
            /insert\(authorityDecisionsTable\)/.test(src) ||
            /INSERT INTO authority_decisions/i.test(src)
          ) {
            offenders.push(path.relative(SRC, full));
          }
        }
      }
    };
    walk(SRC);
    expect(
      offenders,
      "a production writer appeared; if this is #248 landing, move this pin to assert the ONE sanctioned writer",
    ).toEqual([]);
  });
});
