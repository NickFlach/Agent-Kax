/**
 * storefrontCuration.test.ts — #183: owner-curated displays + staff names.
 *
 * The properties: an uncurated store keeps its automatic newest-first feed
 * bit-for-bit; a curated store leads with the OWNER'S order then falls back
 * to newest-first as one pageable sequence; curation cannot conscript
 * another agent's work; staff names persist and surface on the public
 * storefront. All DB-backed (CI).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { db } from "@workspace/db";
import { agentStorefrontSettingsTable, artifactsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import agentStorefrontRouter, { validateCuratedIds } from "../routes/agent-storefront";
import { cleanupTestData, createTestAgent, createTestUser, makeTestId } from "../test-helpers";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(agentStorefrontRouter);
  return app;
}

const app = buildApp();
const made: number[] = [];

async function makeWork(agentId: number, title: string, ingestedAt: Date): Promise<number> {
  const [row] = await db
    .insert(artifactsTable)
    .values({
      externalId: makeTestId("curate"),
      title,
      creatorName: "kax-test-creator",
      publicUrl: "https://example.invalid/x.png",
      artifactType: "image",
      agentId,
      ingestedAt,
    })
    .returning({ id: artifactsTable.id });
  made.push(row!.id);
  return row!.id;
}

describe("storefront curation (#183)", () => {
  let agent: Awaited<ReturnType<typeof createTestAgent>>;
  let agentFull: { id: number; slug: string; obcBotId: string | null };
  let a1: number, a2: number, a3: number;

  beforeAll(async () => {
    const owner = await createTestUser({ emailLabel: "curate" });
    agent = await createTestAgent(owner.id, "curate");
    agentFull = { id: agent.id, slug: agent.slug, obcBotId: null };
    // Newest-first order without curation will be a3, a2, a1.
    a1 = await makeWork(agent.id, "oldest", new Date("2026-01-01T00:00:00Z"));
    a2 = await makeWork(agent.id, "middle", new Date("2026-02-01T00:00:00Z"));
    a3 = await makeWork(agent.id, "newest", new Date("2026-03-01T00:00:00Z"));
  });

  afterAll(async () => {
    await db.delete(agentStorefrontSettingsTable).where(eq(agentStorefrontSettingsTable.agentId, agent.id));
    await db.delete(artifactsTable).where(inArray(artifactsTable.id, made));
    await cleanupTestData();
  });

  it("uncurated: the automatic newest-first feed, unchanged", async () => {
    const res = await request(app).get(`/storefront/by-agent/${agent.slug}/works?limit=10`);
    expect(res.status).toBe(200);
    expect(res.body.artifacts.map((a: { id: number }) => a.id)).toEqual([a3, a2, a1]);
  });

  it("curated: the owner's order leads, the rest follows newest-first, one sequence", async () => {
    await db.insert(agentStorefrontSettingsTable).values({
      agentId: agent.id,
      curatedArtifactIds: [a1, a2], // the owner puts the OLDEST first
      staffNames: { greeter: "Pip", attendant: "Marlow" },
    });
    const res = await request(app).get(`/storefront/by-agent/${agent.slug}/works?limit=10`);
    expect(res.body.artifacts.map((a: { id: number }) => a.id)).toEqual([a1, a2, a3]);
    expect(res.body.total).toBe(3);

    // Pagination crosses the curated/automatic seam without duplication.
    const page = await request(app).get(`/storefront/by-agent/${agent.slug}/works?limit=2&offset=1`);
    expect(page.body.artifacts.map((a: { id: number }) => a.id)).toEqual([a2, a3]);
  });

  it("a curated id whose work vanished degrades the display, never 500s", async () => {
    await db
      .update(agentStorefrontSettingsTable)
      .set({ curatedArtifactIds: [999999999, a2] })
      .where(eq(agentStorefrontSettingsTable.agentId, agent.id));
    const res = await request(app).get(`/storefront/by-agent/${agent.slug}/works?limit=10`);
    expect(res.status).toBe(200);
    expect(res.body.artifacts.map((a: { id: number }) => a.id)).toEqual([a2, a3, a1]);
  });

  it("staff names surface on the public storefront settings", async () => {
    const res = await request(app).get(`/storefront/by-agent/${agent.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.settings.staffNames).toEqual({ greeter: "Pip", attendant: "Marlow" });
  });

  it("curation cannot conscript another agent's work, and garbage is refused whole", async () => {
    const otherOwner = await createTestUser({ emailLabel: "curate2" });
    const other = await createTestAgent(otherOwner.id, "curate2");
    const foreign = await makeWork(other.id, "not yours", new Date("2026-04-01T00:00:00Z"));

    const conscript = await validateCuratedIds(agentFull as never, [a1, foreign]);
    expect(conscript.ok).toBe(false);
    if (!conscript.ok) expect(conscript.error).toContain(String(foreign));

    expect((await validateCuratedIds(agentFull as never, [a1, -5])).ok).toBe(false);
    expect((await validateCuratedIds(agentFull as never, Array.from({ length: 65 }, (_, i) => i + 1))).ok).toBe(false);

    // Valid sets pass, order preserved; empty clears.
    const okPick = await validateCuratedIds(agentFull as never, [a2, a1]);
    expect(okPick).toEqual({ ok: true, ids: [a2, a1] });
    expect(await validateCuratedIds(agentFull as never, [])).toEqual({ ok: true, ids: null });
    expect(await validateCuratedIds(agentFull as never, undefined)).toEqual({ ok: true, ids: null });
  });
});
