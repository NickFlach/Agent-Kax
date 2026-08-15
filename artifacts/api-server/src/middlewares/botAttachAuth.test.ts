/**
 * botAttachAuth.test.ts — a wallet is not what makes attaching safe.
 *
 * Control of a bot is proved by publishing a challenge phrase from it. Holding
 * an Ethereum key says nothing about whether you run that bot, so requiring
 * one to attach kept OCC-verified residents out of their own storefront for no
 * security gain.
 *
 * What the wallet gate DID protect was asymmetry. #112 found a session with no
 * wallet could detach a bot it could never have attached — undoing a
 * wallet-proven attestation without the wallet. That hole is about the
 * relationship between attach and undo, so it is now stated directly:
 *
 *   attach records the strength; changing needs at least that much.
 *
 * These tests exist because relaxing an auth gate is the easiest place in a
 * codebase to be quietly wrong, and the failure would be silent: nobody gets
 * an error when a protection stops applying.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { userBotsTable } from "@workspace/db/schema";
import authBotsRouter from "../routes/auth-bots";
import { cleanupTestData, createTestUser } from "../test-helpers";

const WALLET_BOT = "cccccccc-1111-2222-3333-444444444444";
const SESSION_BOT = "dddddddd-1111-2222-3333-444444444444";

let userId: string;

/**
 * A test app whose session strength is steered by a header, mirroring how
 * lib/auth reports it: a `wallet:` access token plus a wallet on the row.
 */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const uid = req.header("x-test-user");
    if (uid) (req as unknown as { user: { id: string } }).user = { id: uid };
    req.isAuthenticated = function (this: Request) {
      return this.user != null;
    } as Request["isAuthenticated"];
    next();
  });
  app.use(authBotsRouter);
  return app;
}

const app = buildApp();

describe("changing an attachment needs the credential that made it", () => {
  beforeEach(async () => {
    if (!userId) userId = (await createTestUser({ emailLabel: "attach" })).id;
    for (const b of [WALLET_BOT, SESSION_BOT]) {
      await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, b));
    }
    await db.insert(userBotsTable).values([
      { userId, obcBotId: WALLET_BOT, displayName: "Wallet Bot", attachedVia: "wallet" },
      { userId, obcBotId: SESSION_BOT, displayName: "Session Bot", attachedVia: "session" },
    ]);
  });

  afterAll(async () => {
    for (const b of [WALLET_BOT, SESSION_BOT]) {
      await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, b));
    }
    await cleanupTestData();
  });

  it("refuses to detach a WALLET-attached bot from a plain session", async () => {
    // This is #112, and it must stay closed.
    const res = await request(app).delete(`/auth/bots/${WALLET_BOT}`).set("x-test-user", userId);
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/wallet/i);

    const [still] = await db.select().from(userBotsTable).where(eq(userBotsTable.obcBotId, WALLET_BOT));
    expect(still, "the bot was detached anyway").toBeTruthy();
  });

  it("refuses to rename a WALLET-attached bot from a plain session", async () => {
    const res = await request(app)
      .patch(`/auth/bots/${WALLET_BOT}`)
      .set("x-test-user", userId)
      .send({ displayName: "Renamed Without The Wallet" });
    expect(res.status).toBe(403);

    const [row] = await db.select().from(userBotsTable).where(eq(userBotsTable.obcBotId, WALLET_BOT));
    expect(row!.displayName).toBe("Wallet Bot");
  });

  it("lets a plain session change a bot IT attached", async () => {
    // The point of the change: an OCC-verified resident who never touched a
    // crypto wallet still owns their own attachment.
    const res = await request(app)
      .patch(`/auth/bots/${SESSION_BOT}`)
      .set("x-test-user", userId)
      .send({ displayName: "Renamed By Its Owner" });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(userBotsTable).where(eq(userBotsTable.obcBotId, SESSION_BOT));
    expect(row!.displayName).toBe("Renamed By Its Owner");
  });

  it("lets a plain session detach a bot IT attached", async () => {
    const res = await request(app).delete(`/auth/bots/${SESSION_BOT}`).set("x-test-user", userId);
    expect(res.status).toBe(200);
    const rows = await db.select().from(userBotsTable).where(eq(userBotsTable.obcBotId, SESSION_BOT));
    expect(rows).toHaveLength(0);
  });

  it("still requires being signed in at all", async () => {
    expect((await request(app).delete(`/auth/bots/${SESSION_BOT}`)).status).toBe(401);
    expect((await request(app).patch(`/auth/bots/${SESSION_BOT}`).send({ displayName: "x" })).status).toBe(401);
  });

  it("defaults an unmarked row to wallet strength", async () => {
    // Every row that existed before this column did was wallet-attached, and
    // a migration default of anything weaker would have silently unlocked
    // them all.
    await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, WALLET_BOT));
    await db.insert(userBotsTable).values({ userId, obcBotId: WALLET_BOT, displayName: "Legacy" });
    const [row] = await db.select().from(userBotsTable).where(eq(userBotsTable.obcBotId, WALLET_BOT));
    expect(row!.attachedVia).toBe("wallet");

    const res = await request(app).delete(`/auth/bots/${WALLET_BOT}`).set("x-test-user", userId);
    expect(res.status).toBe(403);
  });
});
