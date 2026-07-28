/**
 * agentStatsCounting.test.ts — per-agent stats must count the WORK, not the
 * current lifecycle stage (#116).
 *
 * `GET /agents/:slug` counted `status = 'scored'` and `status = 'narrated'`
 * exactly. Status is a progression, so an artifact that advanced to `dropped`
 * stopped counting as either — the dashboard's numbers went DOWN as work
 * completed.
 *
 * The obvious repair is wrong in the other direction. `lib/visibility` records
 * that the private drop-management route
 *
 *   "lets an owner attach an artifact to a drop *and forcibly stamps its
 *    status to 'dropped'* without going through score → narrate"
 *
 * and #99 describes status being rewritten to `narrated` with no narration
 * attached. So `dropped` does NOT imply scored, and `narrated` does not imply
 * a narration exists. Treating status as cumulative would have inflated the
 * counts with work that never happened — trading an undercount for fabricated
 * numbers.
 *
 * Counting the output columns (`kannakaScore`, `narrative`) is true regardless
 * of where the row later moved, in both directions.
 *
 * Source-level: this asserts which COLUMN the aggregate filters on. A
 * behavioural test needs the DB harness, and this repo's DB-backed suite talks
 * to a real database, which must not be exercised from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "routes", "agents.ts"), "utf8");

/** The Promise.all block that builds the agent-detail stats. */
function statsBlock(): string {
  const start = SRC.indexOf("const agentScope = eq(artifactsTable.agentId, agent.id);");
  expect(start, "agent stats block not found").toBeGreaterThanOrEqual(0);
  // End at the CLOSE of the Promise.all, not at a name that also appears in
  // the destructuring above it — an earlier version anchored on "scarcityRows"
  // and sliced a nearly-empty string, so several assertions "passed" against
  // no content at all.
  const end = SRC.indexOf("  ]);", start);
  expect(end, "end of the stats Promise.all not found").toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("agent stats counting (#116)", () => {
  const block = statsBlock();

  it("counts scored artifacts by kannakaScore, not by status", () => {
    expect(block).toContain("isNotNull(artifactsTable.kannakaScore)");
    expect(
      block.includes('eq(artifactsTable.status, "scored")'),
      "counting status='scored' loses every artifact that has since advanced",
    ).toBe(false);
  });

  it("counts narrated artifacts by narrative, not by status", () => {
    expect(block).toContain("isNotNull(artifactsTable.narrative)");
    expect(
      block.includes('eq(artifactsTable.status, "narrated")'),
      "counting status='narrated' loses every artifact that has since advanced, " +
      "and per #99 can also count rows with no narration at all",
    ).toBe(false);
  });

  it("does NOT treat dropped as implying scored or narrated", () => {
    // The trap. A cumulative-status fix would look like inArray(status,
    // ["scored","narrated","dropped"]) — correct-looking, but it counts
    // force-dropped artifacts that were never scored.
    expect(
      /inArray\(\s*artifactsTable\.status\s*,\s*\[[^\]]*"dropped"[^\]]*\]/.test(block),
      "an owner can attach an artifact to a drop and have its status stamped " +
      "'dropped' without ever being scored or narrated — see lib/visibility",
    ).toBe(false);
  });

  it("still reports dropped as a current-state count", () => {
    // `dropped` genuinely IS a current-status question, so it stays as-is.
    expect(block).toContain('eq(artifactsTable.status, "dropped")');
  });

  it("the premise still holds: status can be stamped without the work", () => {
    // If drop-management ever stops force-stamping status, the reasoning above
    // changes and someone should revisit this.
    const visibility = fs.readFileSync(
      path.join(__dirname, "visibility.ts"), "utf8");
    expect(visibility).toContain("forcibly stamps its status");
  });
});
