/**
 * showcase.test.ts — a truncated count that looks complete.
 *
 * The Joinery's showroom has eighteen plinths, so this endpoint returned
 * eighteen pieces with a `count` of 18 and nothing to say it had stopped
 * early. I read that number as the amount of furniture in the city, said so,
 * and was wrong — the same failure shape as the OBC gallery quietly capping a
 * page at 50 when asked for 100.
 *
 * The property worth guarding is not "it returns 18". It is that whatever it
 * returns, it says what it left out.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import showcaseRouter from "./showcase";
import { cleanupTestData } from "../test-helpers";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(showcaseRouter);
  return app;
}

const app = buildApp();
const MADE: number[] = [];
const MAKER = "Test Census Maker";

describe("furniture showcase", () => {
  beforeAll(async () => {
    // More pieces than the showroom has plinths, so truncation is real rather
    // than theoretical.
    for (let i = 0; i < 25; i++) {
      const [row] = await db
        .insert(artifactsTable)
        .values({
          externalId: `test-census-${i}-${Math.random().toString(36).slice(2)}`,
          title: `Test Census Piece ${i}`,
          creatorName: MAKER,
          publicUrl: "https://example.invalid/p",
          thumbnailUrl: "https://example.invalid/p.jpg",
          artifactType: "furniture",
        })
        .returning({ id: artifactsTable.id });
      MADE.push(row!.id);
    }
  });

  afterAll(async () => {
    if (MADE.length) await db.delete(artifactsTable).where(inArray(artifactsTable.id, MADE));
    await cleanupTestData();
  });

  it("says how much furniture there actually is, not how much it showed", async () => {
    const res = await request(app).get("/showcase/furniture");
    expect(res.status).toBe(200);
    // The floor still holds eighteen.
    expect(res.body.count).toBeLessThanOrEqual(18);
    // But the census is the census.
    expect(res.body.total).toBeGreaterThanOrEqual(25);
    expect(res.body.total).toBeGreaterThan(res.body.count);
    expect(res.body.truncated, "stopped early without saying so").toBe(true);
  });

  it("names every maker, from all the furniture rather than the window", async () => {
    // "Does this agent have any furniture at all" must never be answered from
    // a slice — that is the question that sent me looking in the wrong place.
    const res = await request(app).get("/showcase/furniture");
    const mine = (res.body.byCreator as Array<{ creatorName: string; n: number }>).find(
      (c) => c.creatorName === MAKER,
    );
    expect(mine, "a maker with 25 pieces is missing from the roll").toBeTruthy();
    expect(mine!.n).toBeGreaterThanOrEqual(25);
  });

  it("lets a caller take a real census", async () => {
    const res = await request(app).get("/showcase/furniture?limit=40");
    expect(res.body.count).toBeGreaterThan(18);
    expect(res.body.pieces.length).toBe(res.body.count);
  });

  it("does not claim truncation when it showed everything", async () => {
    // The other direction: a `truncated` that is always true teaches people to
    // ignore it, which puts us back where we started.
    await db.delete(artifactsTable).where(inArray(artifactsTable.id, MADE));
    MADE.length = 0;
    const res = await request(app).get("/showcase/furniture?limit=500");
    expect(res.body.truncated).toBe(res.body.count < res.body.total);
  });

  it("never leaks a public url it was asked to withhold", async () => {
    // Unchanged behaviour, asserted because the response shape moved.
    const res = await request(app).get("/showcase/furniture");
    for (const p of res.body.pieces) expect(p.publicUrl).toBeUndefined();
  });
});
