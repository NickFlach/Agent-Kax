/**
 * arcadeEnumQuery.test.ts — the arcade feed must never send Postgres an
 * `artifact_type` literal the enum doesn't have.
 *
 * `GET /arcade/apps` filters for "app-ish" works and was future-proofed to
 * also accept "link". "link" is not a value of the `artifact_type` enum, and
 * Postgres does NOT treat an unknown enum literal as "matches nothing" — it
 * rejects the comparison outright:
 *
 *     invalid input value for enum artifact_type: "link"
 *
 * So the endpoint 500'd in production and every arcade cabinet in the 3D city
 * went dark, while the code read as if the extra type were harmless.
 *
 * The fix intersects the app-ish list with the live enum before it reaches
 * SQL. These tests pin both halves: the derivation drops unknown types, and
 * the real query shape actually executes against the database.
 */

import { describe, expect, it } from "vitest";
import { and, inArray, isNotNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { artifactsTable, artifactTypeEnum } from "@workspace/db/schema";
import { QUERYABLE_APPISH_TYPES } from "./arcade";

describe("arcade app-type query", () => {
  it("only sends enum values Postgres actually knows", () => {
    const known = artifactTypeEnum.enumValues as readonly string[];
    expect(QUERYABLE_APPISH_TYPES.length).toBeGreaterThan(0);
    for (const t of QUERYABLE_APPISH_TYPES) {
      expect(known).toContain(t);
    }
  });

  it("drops 'link' while the enum lacks it (the value that broke production)", () => {
    const known = artifactTypeEnum.enumValues as readonly string[];
    if (!known.includes("link")) {
      expect(QUERYABLE_APPISH_TYPES).not.toContain("link");
    }
  });

  it("executes the real feed query without a Postgres enum error", async () => {
    // The regression itself: this exact shape threw before the fix.
    await expect(
      db
        .select({ id: artifactsTable.id })
        .from(artifactsTable)
        .where(and(inArray(artifactsTable.artifactType, QUERYABLE_APPISH_TYPES as never), isNotNull(artifactsTable.publicUrl)))
        .limit(1),
    ).resolves.toBeDefined();
  });

  it("proves the unfixed shape is what Postgres rejects", async () => {
    const known = artifactTypeEnum.enumValues as readonly string[];
    if (known.includes("link")) return; // enum gained it; nothing to prove
    await expect(
      db
        .select({ id: artifactsTable.id })
        .from(artifactsTable)
        .where(inArray(artifactsTable.artifactType, ["app", "link"] as never))
        .limit(1),
    ).rejects.toThrow(/invalid input value for enum/i);
  });
});
