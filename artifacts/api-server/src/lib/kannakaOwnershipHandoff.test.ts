/**
 * kannakaOwnershipHandoff.test.ts — the Kannaka ownership handoff must move
 * every owner-scoped table, not just the content ones (#149).
 *
 * `maybeClaimKannakaOwnership()` transferred `agents`, `artifacts` and `drops`
 * from the `kannaka-system` placeholder to the real owner, and stopped there.
 * But the partner-event tables are owner-scoped too: `getOwnerScope()` filters
 * the inbox list routes by `ownerId`, and `canMutate()` blocks non-admins from
 * touching rows owned by someone else.
 *
 * So the new owner inherited the agent and its artifacts while every proposal,
 * DM, match and sent message stayed behind on the placeholder — an agent whose
 * conversation history they could neither see nor reply to. That is precisely
 * the continuity the handoff exists to preserve.
 *
 * `claimLegacyOwnership()` in the same file already migrates this full set for
 * the legacy-account path, so the two handoffs are asserted against each other
 * below: whichever set of owner-scoped tables one moves, the other should too.
 *
 * Source-level on purpose, matching the neighbouring suites: `backfill.ts`
 * imports the `@workspace/db` singleton, which throws at import unless
 * DATABASE_URL is set, and exercising the handoff behaviourally needs the
 * real-database harness that must not run from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(path.join(__dirname, "backfill.ts"), "utf8");

/** Source with comment-only lines dropped, so prose never satisfies a check. */
function code(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const CODE = code(SRC);

/** A named exported function's body, up to the next top-level export. */
function fnBody(name: string): string {
  const start = CODE.indexOf(`export async function ${name}`);
  expect(start, `${name} not found in backfill.ts`).toBeGreaterThanOrEqual(0);
  const next = CODE.indexOf("\nexport ", start + 1);
  return CODE.slice(start, next > start ? next : undefined);
}

const CLAIM = fnBody("maybeClaimKannakaOwnership");
const LEGACY = fnBody("claimLegacyOwnership");

/** Owner-scoped tables the inbox and history surfaces read through. */
const PARTNER_EVENT_TABLES = [
  "proposalsTable",
  "dmsTable",
  "matchesTable",
  "outboundMessagesTable",
  "activitiesTable",
] as const;

describe("Kannaka ownership handoff (#149)", () => {
  describe("migrates the owner-scoped partner-event tables", () => {
    for (const table of PARTNER_EVENT_TABLES) {
      it(`transfers ${table}`, () => {
        expect(
          CLAIM.includes(table),
          `${table} is owner-scoped, so leaving it on kannaka-system hands the ` +
            `new owner an agent whose history they cannot see or reply to`,
        ).toBe(true);
      });
    }
  });

  describe("the premise: these tables really are owner-scoped", () => {
    it("the schema gives each one an ownerId", () => {
      const schema = fs.readFileSync(
        path.join(__dirname, "..", "..", "..", "..", "lib", "db", "src", "schema", "partner-events.ts"),
        "utf8");
      // activitiesTable lives elsewhere; the four partner-event tables are here.
      for (const t of ["proposalsTable", "dmsTable", "matchesTable", "outboundMessagesTable"]) {
        const at = schema.indexOf(`export const ${t} = pgTable(`);
        expect(at, `${t} not found`).toBeGreaterThanOrEqual(0);
        const next = schema.indexOf("export const ", at + 1);
        const body = schema.slice(at, next > at ? next : undefined);
        expect(body, `${t} must carry an ownerId`).toContain('ownerId: text("owner_id")');
      }
    });

    it("the list routes filter on that ownerId", () => {
      const routes = code(fs.readFileSync(
        path.join(__dirname, "..", "routes", "partner-events.ts"), "utf8"));
      expect(routes).toContain("getOwnerScope(req)");
      expect(routes).toContain("eq(proposalsTable.ownerId, ownerScope)");
      expect(routes).toContain("eq(dmsTable.ownerId, ownerScope)");
    });
  });

  describe("stays consistent with the legacy-account handoff", () => {
    for (const table of PARTNER_EVENT_TABLES) {
      it(`claimLegacyOwnership also moves ${table}`, () => {
        // Pins the two handoffs together. If a future owner-scoped table is
        // added to one path only, whichever side was forgotten shows up here
        // rather than as a silently stranded inbox months later.
        expect(LEGACY).toContain(table);
      });
    }
  });

  describe("idempotence", () => {
    it("scopes every transfer to rows still on the placeholder", () => {
      // Once a row has moved it no longer matches, so a re-run is a no-op and
      // the handoff can stay on the login path. A transfer that dropped this
      // predicate would seize rows the owner had deliberately reassigned.
      expect(CLAIM).toContain("KANNAKA_SYSTEM_USER_ID");
      const moves = CLAIM.split("\n").filter((l) => l.includes(".set({ ownerId: user.id })"));
      expect(moves.length).toBeGreaterThan(0);
      expect(CLAIM).toContain("eq(table.ownerId, KANNAKA_SYSTEM_USER_ID)");
    });

    it("still refuses to retake an agent a human reassigned", () => {
      // Pre-existing guarantee worth keeping visible: the agent transfer is
      // conditional on the placeholder still owning it.
      expect(CLAIM).toContain("eq(agentsTable.ownerId, KANNAKA_SYSTEM_USER_ID)");
    });
  });
});
