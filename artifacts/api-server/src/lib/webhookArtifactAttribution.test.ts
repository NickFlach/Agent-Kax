/**
 * webhookArtifactAttribution.test.ts — `artifact.created` must map an incoming
 * artifact to its agent by OBC bot id, not by slug (#102).
 *
 * `PartnerArtifact.creator.id` is the OBC bot UUID: partnerClient normalises it
 * from `creator.id ?? creator_bot_id ?? fallback.creatorBotId`. The handler
 * compared that value against `agents.slug` — a different namespace — so the
 * lookup essentially never matched. Every webhook-ingested artifact landed with
 * `agentId: null`, owned by the system user, with the agent's
 * `artifactsHarvested` counter untouched.
 *
 * It compounded: the handler also left `artifacts.creator_bot_id` null, while
 * the harvester stamps it and backfill repairs attribution by joining
 * `artifacts.creator_bot_id -> agents.obc_bot_id`. A mis-attributed webhook
 * artifact therefore could not be repaired after the fact either.
 *
 * Source-level on purpose. The behavioural assertion here is "which column does
 * this query filter on", and this repo's DB-backed suite talks to a real
 * database, which must not be exercised from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const HANDLER = fs.readFileSync(
  path.join(__dirname, "eventHandlers", "artifactCreated.ts"), "utf8");

const PARTNER_CLIENT = fs.readFileSync(
  path.join(__dirname, "partnerClient.ts"), "utf8");

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

/** The agent-lookup region: from the creator id read to the insert call. */
function lookupBlock(): string {
  const src = code(HANDLER);
  const start = src.indexOf("pa.creator?.id");
  expect(start, "creator id read not found").toBeGreaterThanOrEqual(0);
  const insertAt = src.indexOf(".insert(artifactsTable)", start);
  expect(insertAt, "artifact insert not found after the lookup").toBeGreaterThan(start);
  return src.slice(start, insertAt);
}

describe("webhook artifact attribution (#102)", () => {
  describe("the premise: creator.id is a bot id, not a slug", () => {
    it("partnerClient normalises creator.id from bot-id sources", () => {
      // If this ever stops being true, the fix below is wrong and someone
      // should revisit it rather than trusting these assertions.
      // Anchored on the normalisation expression, not on `creator: {` — the
      // first `creator: {` in this file is the PartnerArtifact interface
      // declaration, and slicing from there measures type fields that contain
      // none of this, so the assertion failed against correct source.
      const block = code(PARTNER_CLIENT);
      const at = block.indexOf("raw.creator?.id");
      expect(at, "creator id normalisation not found").toBeGreaterThanOrEqual(0);
      const creatorMapping = block.slice(at, at + 200);
      expect(creatorMapping).toContain("creator_bot_id");
      expect(creatorMapping).toContain("creatorBotId");
    });

    it("agents carries a distinct obc_bot_id column to match on", () => {
      const schema = fs.readFileSync(
        path.join(__dirname, "..", "..", "..", "..", "lib", "db", "src", "schema", "agents.ts"),
        "utf8");
      expect(schema).toContain('obcBotId: text("obc_bot_id")');
      expect(schema).toContain('slug: text("slug")');
    });
  });

  describe("the lookup", () => {
    const block = lookupBlock();

    it("matches the agent on obcBotId", () => {
      expect(
        block.includes("eq(agentsTable.obcBotId,"),
        "the agent lookup must filter on agents.obc_bot_id — matching a bot " +
        "UUID against agents.slug never hits, leaving every webhook artifact " +
        "unattributed",
      ).toBe(true);
    });

    it("tries obcBotId before falling back to slug", () => {
      const byBotId = block.indexOf("eq(agentsTable.obcBotId,");
      const bySlug = block.indexOf("eq(agentsTable.slug,");
      expect(byBotId).toBeGreaterThanOrEqual(0);
      if (bySlug >= 0) {
        expect(
          byBotId < bySlug,
          "bot id is the canonical key and must be tried first; a slug match " +
          "is only a fallback for agents whose obc_bot_id is still null",
        ).toBe(true);
      }
    });

    it("does not read the bot id into a variable named like a slug", () => {
      // The original defect was legible in the naming: `creatorSlug` was
      // assigned `pa.creator?.id`. Keeping the name honest is what stops the
      // next reader from re-introducing a slug comparison.
      expect(block).not.toContain("creatorSlug");
    });
  });

  describe("repairability", () => {
    it("stamps creatorBotId on the inserted artifact", () => {
      const src = code(HANDLER);
      const insertAt = src.indexOf(".insert(artifactsTable)");
      const returningAt = src.indexOf(".returning(", insertAt);
      expect(returningAt).toBeGreaterThan(insertAt);
      const values = src.slice(insertAt, returningAt);
      expect(
        /(^|\s)creatorBotId[,:]/.test(values),
        "artifacts.creator_bot_id must be stamped — backfill repairs " +
        "attribution by joining it against agents.obc_bot_id, so leaving it " +
        "null makes a mis-attributed webhook artifact unrepairable",
      ).toBe(true);
    });

    it("backfill still repairs attribution via that join", () => {
      // Guards the premise of the assertion above.
      const backfill = fs.readFileSync(path.join(__dirname, "backfill.ts"), "utf8");
      expect(backfill).toContain("artifactsTable.creatorBotId");
      expect(backfill).toContain("agentsTable.obcBotId");
    });
  });
});
