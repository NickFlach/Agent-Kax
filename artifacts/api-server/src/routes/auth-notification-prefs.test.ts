/**
 * auth-notification-prefs.test.ts — PATCH /me/notification-prefs is a WRITE
 * path, and the only thing between a disabled account and that write is the
 * `requireAuth` argument at routes/auth.ts:93 (#275).
 *
 * Nothing pinned it. No test under artifacts/api-server/src mentioned
 * notification-prefs at all, so deleting that one token — a plausible-looking
 * cleanup, since the handler already reads `req.user!` and would still
 * typecheck — silently restores a disabled-account write path with CI green.
 * That is the same shape as #161/#162/#163: a correct guard, no assertion, and
 * a later refactor quietly removing it.
 *
 * Behavioural rather than source-level on purpose. lib/publicRouteGating.test.ts
 * pins WHICH PREDICATE a handler applies; the property here is what the server
 * DOES for a caller it has already disowned, and requireAuth decides that with
 * a live per-request row read (middlewares/requireAuth.ts:12-16) that only a
 * real database exercises. CI runs the migration chain against a throwaway
 * Postgres, so this runs with the rest of the DB-backed suite.
 *
 * Every refusal is paired with the same request succeeding, so a case that
 * stops proving anything fails loudly instead of passing vacuously.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import pino from "pino";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import authRouter from "./auth";
import "../middlewares/authMiddleware";
import { cleanupTestData, createTestUser } from "../test-helpers";

/**
 * Same harness as agents-admin-listing.test.ts: a session carrying an id and
 * NOTHING else, which is what production restores. Deliberately no `role` and
 * no `disabledAt` — everything the guard decides on must come from the
 * database, not from the session payload.
 */
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
  app.use(authRouter);
  return app;
}

const PREFS = "/me/notification-prefs";

async function prefsOf(id: string): Promise<{ emailOnProposal: boolean; emailOnDm: boolean }> {
  const [row] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  return { emailOnProposal: row!.emailOnProposal, emailOnDm: row!.emailOnDm };
}

describe("PATCH /me/notification-prefs is guarded by requireAuth (#275)", () => {
  const app = buildApp();
  let user: { id: string };

  beforeEach(async () => {
    await cleanupTestData();
    user = await createTestUser();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("lets an account in good standing set its own prefs", async () => {
    // The direction that must keep working. Without it, a guard that refused
    // everyone would satisfy every assertion below for the wrong reason.
    const res = await request(app)
      .patch(PREFS)
      .set("x-test-user", user.id)
      .send({ emailOnDm: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ emailOnProposal: false, emailOnDm: true });
    expect(await prefsOf(user.id)).toEqual({ emailOnProposal: false, emailOnDm: true });
  });

  it("refuses an anonymous write with 401 and changes nothing", async () => {
    const res = await request(app).patch(PREFS).send({ emailOnDm: true });

    // 401, specifically: unmounting the guard makes this a TypeError on
    // `req.user!.id` (a 500), which is a different answer, not a refusal.
    expect(res.status).toBe(401);
    expect(await prefsOf(user.id)).toEqual({ emailOnProposal: false, emailOnDm: false });
  });

  it("refuses a disabled account with 403 and writes nothing", async () => {
    // THE load-bearing case. The write is shown landing first, so the refusal
    // afterwards cannot be an artefact of the update never working at all.
    const before = await request(app)
      .patch(PREFS)
      .set("x-test-user", user.id)
      .send({ emailOnProposal: true });
    expect(before.status).toBe(200);
    expect(await prefsOf(user.id)).toEqual({ emailOnProposal: true, emailOnDm: false });

    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, user.id));

    const res = await request(app)
      .patch(PREFS)
      .set("x-test-user", user.id)
      .send({ emailOnProposal: false, emailOnDm: true });

    expect(res.status, "a disabled account must not be able to write its prefs").toBe(403);
    expect(await prefsOf(user.id), "the disabled account's write must not have landed").toEqual({
      emailOnProposal: true,
      emailOnDm: false,
    });
  });

  it("refuses the empty-body read branch from a disabled account too", async () => {
    // With no recognised keys the handler answers with the STORED prefs
    // instead of updating them. That branch is behind the same guard, and it
    // still tells a disowned session what the account is set to.
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, user.id));

    const res = await request(app).patch(PREFS).set("x-test-user", user.id).send({});

    expect(res.status).toBe(403);
    expect(res.body.emailOnProposal, "prefs leaked to a disabled account").toBeUndefined();
    expect(res.body.emailOnDm, "prefs leaked to a disabled account").toBeUndefined();
  });

  it("refuses a session naming a user row that no longer exists", async () => {
    // requireAuth's `!user` arm: a session outliving its row must not pass
    // just because the request parsed as authenticated.
    const ghost = user.id;
    await db.delete(usersTable).where(eq(usersTable.id, ghost));

    const res = await request(app).patch(PREFS).set("x-test-user", ghost).send({ emailOnDm: true });

    expect(res.status).toBe(403);
  });

  it("still validates the body for a caller who passes the guard", async () => {
    // So "403 to everything" could never masquerade as a working guard: this
    // 400 proves requests do reach the handler.
    const res = await request(app)
      .patch(PREFS)
      .set("x-test-user", user.id)
      .send({ emailOnDm: "yes" });

    expect(res.status).toBe(400);
    expect(await prefsOf(user.id)).toEqual({ emailOnProposal: false, emailOnDm: false });
  });
});
