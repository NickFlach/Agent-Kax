/**
 * artifacts-narrate.test.ts — POST /artifacts/:id/narrate, behaviourally (#275).
 *
 * #153 was fixed by deleting an undeclared `transmissionNum`, and the only
 * thing preventing that exact defect from returning is TS2304 under
 * `pnpm run typecheck`. That is a side effect, not a pin: no test mentioned
 * this route, so its AUTH shape and its determinism were both unasserted.
 *
 * The auth shape is the subtle half. The handler looks up the artifact and
 * 404s BEFORE it consults `canMutate()` (artifacts.ts:170-179), and canMutate
 * returns false for an unauthenticated caller. So with `requireAuth` removed
 * from the mount at artifacts.ts:166 the route still LOOKS guarded — it just
 * answers an anonymous stranger 403 for an artifact that exists and 404 for
 * one that does not, which is an existence oracle over every artifact id in
 * the exchange. Only `requireAuth` collapses both into 401.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import pino from "pino";
import { z } from "zod";
import { db } from "@workspace/db";
import { artifactsTable, usersTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import artifactsRouter from "./artifacts";
import "../middlewares/authMiddleware";
import { cleanupTestData, createTestUser, makeTestId } from "../test-helpers";

/** Same harness as agents-ownership.test.ts, ZodError tail included. */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  const testLog = pino({ level: "silent" });
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { log: unknown }).log = testLog;
    const userId = req.header("x-test-user");
    if (userId) {
      (req as unknown as { user: { id: string } }).user = { id: userId };
    }
    req.isAuthenticated = function (this: Request) {
      return this.user != null;
    } as Request["isAuthenticated"];
    next();
  });
  app.use(artifactsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  });
  return app;
}

const app = buildApp();
const MADE: number[] = [];

const narrate = (id: number | string) => `/artifacts/${id}/narrate`;

async function makeArtifact(ownerId: string): Promise<number> {
  const [row] = await db
    .insert(artifactsTable)
    .values({
      externalId: makeTestId("narrate"),
      title: "Test Narration Subject",
      creatorName: "Test Maker",
      publicUrl: "https://example.invalid/a",
      thumbnailUrl: "https://example.invalid/a.jpg",
      artifactType: "image",
      ownerId,
    })
    .returning({ id: artifactsTable.id });
  MADE.push(row!.id);
  return row!.id;
}

async function rowOf(id: number) {
  const [row] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);
  return row;
}

describe("POST /artifacts/:id/narrate", () => {
  let owner: { id: string };
  let stranger: { id: string };
  let admin: { id: string };
  let artifactId: number;

  beforeEach(async () => {
    owner = await createTestUser();
    stranger = await createTestUser();
    admin = await createTestUser({ role: "admin" });
    artifactId = await makeArtifact(owner.id);
  });

  // Between cases, not only at the end. A narrated artifact carries
  // status='narrated', which is a PUBLISHABLE status — so a hard failure
  // mid-suite would leave live-looking rows behind for every later run to
  // trip over. Deleting per case costs nothing and keeps a rerun honest.
  afterEach(async () => {
    if (MADE.length) await db.delete(artifactsTable).where(inArray(artifactsTable.id, MADE));
    MADE.length = 0;
  });

  afterAll(async () => {
    // Artifacts first: cleanupTestData() sweeps users and prefixed activity
    // rows but never touches `artifacts`, and ownerId is ON DELETE SET NULL,
    // so an un-deleted row would survive as untraceable litter.
    if (MADE.length) await db.delete(artifactsTable).where(inArray(artifactsTable.id, MADE));
    await cleanupTestData();
  });

  it("narrates an artifact for its owner", async () => {
    // The direction that must work — every refusal below is only meaningful
    // because this one succeeds.
    const res = await request(app).post(narrate(artifactId)).set("x-test-user", owner.id);

    expect(res.status).toBe(200);
    expect(res.body.narrative).toEqual(expect.any(String));
    expect(String(res.body.narrative).length).toBeGreaterThan(0);
    expect(res.body.status).toBe("narrated");
    expect(res.body.narratedAt).not.toBeNull();
    expect(res.body.transmissionId).toBe(`TX-${String(artifactId).padStart(3, "0")}`);
  });

  it("does not let an anonymous caller tell a real artifact from a missing one", async () => {
    // The pin on the `requireAuth` argument at artifacts.ts:166, and the case
    // that fails if it is deleted: the handler's own canMutate() check answers
    // 403 for an id that exists and the earlier lookup answers 404 for one
    // that does not, so an unguarded route is a working existence oracle.
    const gone = await makeArtifact(owner.id);
    await db.delete(artifactsTable).where(eq(artifactsTable.id, gone));

    const real = await request(app).post(narrate(artifactId));
    const missing = await request(app).post(narrate(gone));

    expect(real.status, "an anonymous caller must be refused before the lookup").toBe(401);
    expect(missing.status, "a missing id must answer identically to a real one").toBe(401);
    expect(real.status).toBe(missing.status);
    // ...and the real artifact is untouched.
    expect((await rowOf(artifactId))!.narrative).toBeNull();
  });

  it("answers a signed-in caller 404 for an id that does not exist", async () => {
    // The contrast that makes the 401s above load-bearing rather than a
    // blanket "everything is 401": the 404 branch is reachable, just not
    // from outside the guard.
    const gone = await makeArtifact(owner.id);
    await db.delete(artifactsTable).where(eq(artifactsTable.id, gone));

    const res = await request(app).post(narrate(gone)).set("x-test-user", stranger.id);

    expect(res.status).toBe(404);
  });

  it("refuses a disabled owner with 403 and leaves the artifact unnarrated", async () => {
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, owner.id));

    const res = await request(app).post(narrate(artifactId)).set("x-test-user", owner.id);

    expect(res.status).toBe(403);
    const row = await rowOf(artifactId);
    expect(row!.narrative, "a disabled account wrote to the artifact").toBeNull();
    expect(row!.status).toBe("raw");
  });

  it("refuses a signed-in stranger with 403 and leaves the artifact unnarrated", async () => {
    const res = await request(app).post(narrate(artifactId)).set("x-test-user", stranger.id);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not authorized/i);
    expect((await rowOf(artifactId))!.narrative).toBeNull();
  });

  it("lets an admin narrate another user's artifact", async () => {
    // canMutate's admin branch reads the role from the database, because
    // AuthUser.role is optional and the session never carries one — a
    // session-derived check would make this branch dead code.
    const res = await request(app).post(narrate(artifactId)).set("x-test-user", admin.id);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("narrated");
  });

  it("re-narrating is stable rather than randomised (#153)", async () => {
    // The transmission id used to be `TX-` + a random 1..999, which collided
    // once you had a few hundred artifacts; it is now derived from the
    // artifact id, and the narrative text is picked by the same index. Two
    // calls must therefore agree exactly — that is the behavioural half of a
    // fix currently held up only by the type checker.
    const first = await request(app).post(narrate(artifactId)).set("x-test-user", owner.id);
    const second = await request(app).post(narrate(artifactId)).set("x-test-user", owner.id);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.transmissionId).toBe(first.body.transmissionId);
    expect(second.body.narrative).toBe(first.body.narrative);
    expect(second.body.narrativeTitle).toBe(first.body.narrativeTitle);
    expect(second.body.status).toBe("narrated");
  });
});
