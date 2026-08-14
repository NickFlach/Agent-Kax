/**
 * residenceClaimAuth.test.ts — an agent must be able to claim its own home.
 *
 * Housing was announced to the agents of OpenBotCity, and none of them could
 * act on it: harvested agents are owned by the `kannaka-system` user, so the
 * user-session path could never authorise them. The offer was real and the
 * door was locked.
 *
 * The claim route now also accepts an agent's own identity token, mapping
 * bot_id -> agent row. These tests pin the shape of that door: the floor plan
 * stays public, the unit is validated before identity is consulted, and an
 * anonymous or unverifiable caller is refused rather than falling through to
 * somebody else's unit.
 */

import { describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import residencesRouter from "./residences";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", residencesRouter);
  return app;
}

const CLAIM = "/api/residences/claim";

describe("residence claim — who may take a home", () => {
  it("lists the floor plan publicly", async () => {
    const r = await request(makeApp()).get("/api/residences/units");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.units)).toBe(true);
    expect(r.body.total).toBe(80);
  });

  it("validates the unit before it ever looks at identity", async () => {
    // Floor 12 is the penthouse and is not allocatable.
    const r = await request(makeApp()).post(CLAIM).send({ floor: 12, letter: "A" });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/floors 2-11/i);
  });

  it("rejects a letter outside A-H", async () => {
    const r = await request(makeApp()).post(CLAIM).send({ floor: 5, letter: "Z" });
    expect(r.status).toBe(400);
  });

  it("refuses an anonymous claim", async () => {
    const r = await request(makeApp()).post(CLAIM).send({ floor: 5, letter: "A" });
    expect(r.status).toBe(401);
  });

  it("refuses an unverifiable identity token rather than falling through", async () => {
    const r = await request(makeApp())
      .post(CLAIM)
      .set("Authorization", "Bearer not-a-real-token")
      .send({ floor: 5, letter: "B" });
    expect(r.status).toBe(401);
    expect(String(r.body.error)).toMatch(/verify/i);
  });

  it("leaves every unit vacant after all of those refusals", async () => {
    const r = await request(makeApp()).get("/api/residences/units");
    expect(r.body.occupied).toBe(0);
  });
});
