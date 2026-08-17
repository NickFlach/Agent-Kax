/**
 * storefrontRecency.test.ts — publishing and ingesting are different questions.
 *
 * `GET /marketplace/combined` exposed `latestPublishedAt` — when a storefront
 * last published a DROP — and nothing about when it last took in a work. Those
 * come apart badly: a store can publish no drops for a year while its agent
 * posts daily, and every dormancy-keyed decision reading `latestPublishedAt`
 * would call it dead. Live, 278 of 302 storefronts have never published a drop
 * at all, so that field says almost nothing about almost everyone.
 *
 * The additions are additive by design, and these tests are mostly about
 * proving that: no existing key changes shape, and the new one is present with
 * an explicit null rather than omitted. An absent key and a null key are
 * different answers, and only one of them survives a round trip through JSON
 * into a client that does `?? fallback`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import marketplaceCombinedRouter from "../routes/marketplace-combined";
import { listObcStorefronts } from "./storefrontDirectory";
import { cleanupTestData, createTestAgent, createTestUser } from "../test-helpers";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(marketplaceCombinedRouter);
  return app;
}

const here = dirname(fileURLToPath(import.meta.url));
const app = buildApp();
const madeArtifacts: number[] = [];
let owner: { id: string };
let agentSlug: string;

describe("storefront recency", () => {
  beforeAll(async () => {
    owner = await createTestUser({ emailLabel: "recency" });
    const agent = await createTestAgent(owner.id, "recency");
    agentSlug = agent.slug;
    // A storefront needs work to appear in the directory at all.
    const [row] = await db
      .insert(artifactsTable)
      .values({
        externalId: `test-recency-${Math.random().toString(36).slice(2)}`,
        title: "Test Recency Piece",
        creatorName: "Test Recency Maker",
        publicUrl: "https://example.invalid/r",
        artifactType: "image",
        agentId: agent.id,
      })
      .returning({ id: artifactsTable.id });
    madeArtifacts.push(row!.id);
  });

  afterAll(async () => {
    if (madeArtifacts.length) {
      await db.delete(artifactsTable).where(inArray(artifactsTable.id, madeArtifacts));
    }
    await cleanupTestData();
  });

  it("reports when a storefront last took in a work", async () => {
    const res = await request(app).get("/marketplace/combined");
    expect(res.status).toBe(200);
    const mine = (res.body.storefronts as Array<{ slug: string; latestIngestAt: string | null }>).find(
      (s) => s.slug === agentSlug,
    );
    expect(mine, "the seeded storefront is missing from the directory").toBeTruthy();
    expect(mine!.latestIngestAt, "a store with a work reports no ingest time").not.toBeNull();
    // ISO-8601, because a client will sort and compare these as strings.
    expect(mine!.latestIngestAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(Date.parse(mine!.latestIngestAt!))).toBe(false);
  });

  it("gives every row the key, present and explicitly null where unknown", async () => {
    // The failure this guards: `latestIngestAt` omitted on constellation rows
    // rather than null. `undefined` disappears through JSON.stringify, so a
    // client checking `"latestIngestAt" in row` would see the field vanish on
    // exactly the rows it needs to treat differently.
    const res = await request(app).get("/marketplace/combined");
    const rows = res.body.storefronts as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, "latestIngestAt"), `${row.slug} omits the key`).toBe(true);
      const v = row["latestIngestAt"];
      expect(v === null || typeof v === "string", `${row.slug} has a ${typeof v}`).toBe(true);
    }
    // Constellation rows are seeded by the bridge, not by these fixtures, so
    // a fresh database has none — and a loop over an empty list passes
    // whatever the code does. I checked: deleting the explicit
    // `latestIngestAt: null` from that mapper left this test green.
    //
    // So the constellation branch is asserted at the SOURCE instead. Less
    // satisfying than a round trip, and considerably better than a loop that
    // cannot fail.
    const constellationRows = rows.filter((r) => r["source"] === "constellation");
    for (const row of constellationRows) {
      expect(row["latestIngestAt"], `constellation row ${row["slug"]} claims an ingest`).toBeNull();
    }
    const routeSrc = readFileSync(join(here, "..", "routes", "marketplace-combined.ts"), "utf8");
    const constellationMapper = routeSrc.slice(routeSrc.indexOf("latestPublishedAt: null,"));
    expect(
      constellationMapper.includes("latestIngestAt: null,"),
      "the constellation mapper omits latestIngestAt instead of nulling it",
    ).toBe(true);
  });

  it("changes no existing key", async () => {
    // Additive means additive. A client reading this endpoint today must not
    // notice anything except one more field.
    const res = await request(app).get("/marketplace/combined");
    const row = (res.body.storefronts as Array<Record<string, unknown>>)[0]!;
    for (const key of [
      "source",
      "slug",
      "displayName",
      "agent",
      "settings",
      "publishedDropCount",
      "artifactCount",
      "latestPublishedAt",
      "claimed",
      "phi",
      "consciousnessLevel",
      "lastSeenAt",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(row, key), `lost the ${key} key`).toBe(true);
    }
  });

  it("carries the same instant the directory computed", async () => {
    // The route must not re-derive or reformat it. Two sources for one fact is
    // how the checkout and the webhook came to disagree about a URL.
    const directory = await listObcStorefronts();
    const entry = directory.find((e) => e.agent.slug === agentSlug);
    expect(entry, "the directory lost the seeded storefront").toBeTruthy();

    const res = await request(app).get("/marketplace/combined");
    const row = (res.body.storefronts as Array<{ slug: string; latestIngestAt: string | null }>).find(
      (s) => s.slug === agentSlug,
    );
    expect(row!.latestIngestAt).toBe(entry!.latestIngestAt?.toISOString() ?? null);
  });
});
