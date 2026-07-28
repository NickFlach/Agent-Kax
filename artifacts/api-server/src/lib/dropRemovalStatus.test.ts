/**
 * dropRemovalStatus.test.ts — leaving a drop must restore the status the
 * artifact actually merits (#99).
 *
 * Both removal paths — `DELETE /drops/:id` and
 * `DELETE /drops/:dropId/artifacts/:artifactId` — set `status: "narrated"`
 * unconditionally. An artifact that was only ever `scored` came back claiming a
 * narration it does not have.
 *
 * That lie is load-bearing rather than cosmetic: `narrated` is one of
 * PUBLISHABLE_STATUSES, so re-adding such an artifact to a published drop would
 * surface it publicly as narrated work. It is also the upstream cause of the
 * decoupling worked around in #116, where per-agent stats had to stop trusting
 * `status` and count the output columns instead.
 *
 * Source-level: this asserts the shape of two bulk UPDATE statements. A
 * behavioural test needs the DB harness, and this repo's DB-backed suite talks
 * to a real database, which must not be exercised from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "routes", "drops.ts"), "utf8");

describe("drop removal status restore (#99)", () => {
  it("neither removal path hardcodes narrated", () => {
    // Skip comments — the explanation above `restoredStatus` quotes the old
    // line verbatim, and an earlier version of this assertion flagged its own
    // documentation as the offence.
    const blanket = SRC.split("\n")
      .map((l, i) => [i + 1, l.trim()] as const)
      .filter(([, l]) => !l.startsWith("*") && !l.startsWith("//") && !l.startsWith("/*"))
      .filter(([, l]) => l.includes('status: "narrated"'));
    expect(
      blanket.map(([n, l]) => `drops.ts:${n}: ${l}`),
      "removing an artifact from a drop must not invent a narration",
    ).toEqual([]);
  });

  it("both removal paths use the derived status", () => {
    const uses = SRC.split("\n").filter((l) => l.includes("status: restoredStatus"));
    expect(uses.length, "expected both DELETE paths to restore the derived status").toBe(2);
  });

  it("the derived status is evidence-based, in priority order", () => {
    const decl = SRC.slice(SRC.indexOf("const restoredStatus"), SRC.indexOf("router.delete"));
    const narrativeAt = decl.indexOf("narrative");
    const scoreAt = decl.indexOf("kannakaScore");
    expect(narrativeAt, "narrative branch missing").toBeGreaterThanOrEqual(0);
    expect(scoreAt, "kannakaScore branch missing").toBeGreaterThanOrEqual(0);
    expect(
      narrativeAt < scoreAt,
      "narrative must be checked first — a narrated artifact also has a score, " +
      "so checking the score first would downgrade it to 'scored'",
    ).toBe(true);
    expect(decl).toContain("'raw'");
  });

  it("the CASE is cast to the enum type", () => {
    // A CASE yields text; `status` is a pgEnum column. Without the cast this
    // fails at runtime on every drop deletion, which a source-only check would
    // otherwise happily miss.
    const decl = SRC.slice(SRC.indexOf("const restoredStatus"), SRC.indexOf("router.delete"));
    expect(decl).toContain("::artifact_status");
  });

  it("attaching to a drop still stamps dropped", () => {
    // The opposite direction: this fix is about RESTORING on the way out, and
    // must not disturb the way in.
    expect(SRC).toContain('status: "dropped"');
  });
});
