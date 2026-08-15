/**
 * identityResolve.test.ts — the route exists, and keeps existing.
 *
 * It did not. #222 shipped the resolver library with seven passing tests, a PR
 * describing GET /api/identity/resolve as available, and NO ROUTE: a patch
 * inserted the import and silently failed to insert the handler. Typecheck was
 * happy — an unused import is not an error — and the library tests passed,
 * because they tested the library.
 *
 * The observatory's channel door then called that URL on every proposal, got
 * the SPA's HTML 404, read it as "not proved", and filed everything for
 * curation. It failed closed, so nothing unsafe happened; it simply never
 * worked, and said nothing about it.
 *
 * Testing the lib is not testing the door. These call the route.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { userBotsTable } from "@workspace/db/schema";
import identityRouter from "./identity";
import { cleanupTestData, createTestUser } from "../test-helpers";

const NPUB = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsx7ttyn";
const HANDLE = "resolver-test.bsky.social";
const BOT = "bbbbbbbb-1111-2222-3333-444444444444";

const app: Express = express();
app.use(express.json());
app.use(identityRouter);

let userId: string;

describe("GET /identity/resolve", () => {
  beforeEach(async () => {
    if (!userId) userId = (await createTestUser({ emailLabel: "resolve" })).id;
    await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, BOT));
  });

  afterAll(async () => {
    await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, BOT));
    await cleanupTestData();
  });

  it("is mounted at all", async () => {
    // The assertion that would have caught #222: anything other than the SPA
    // swallowing the path. A 400 here is a route answering.
    const res = await request(app).get("/identity/resolve");
    expect(res.status).toBe(400);
    expect(res.body.resolvable).toContain("nostr:");
  });

  it("resolves a proved npub to its canonical principal", async () => {
    await db.insert(userBotsTable).values({
      userId, obcBotId: BOT, displayName: "Resolver Test",
      npub: NPUB, npubVerifiedAt: new Date("2026-08-01T00:00:00Z"),
    });
    const res = await request(app).get("/identity/resolve").query({ principal: `nostr:${NPUB}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ proved: true, principal: `obc:${BOT}`, botId: BOT, via: "npub" });
  });

  it("resolves a proved bluesky handle", async () => {
    await db.insert(userBotsTable).values({
      userId, obcBotId: BOT, displayName: "Resolver Test",
      bskyHandle: HANDLE, bskyVerifiedAt: new Date("2026-08-02T00:00:00Z"),
    });
    const res = await request(app).get("/identity/resolve").query({ principal: `bsky:${HANDLE}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ proved: true, principal: `obc:${BOT}`, via: "bsky" });
  });

  it("404s an identity that has not proved anything, with proved:false", async () => {
    await db.insert(userBotsTable).values({ userId, obcBotId: BOT, displayName: "Resolver Test" });
    const res = await request(app).get("/identity/resolve").query({ principal: `nostr:${NPUB}` });
    expect(res.status).toBe(404);
    expect(res.body.proved).toBe(false);
    // JSON, not HTML — the caller must be able to tell "not proved" from
    // "this endpoint isn't here", which is exactly what went wrong.
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("400s a channel with no link flow, and says which have one", async () => {
    const res = await request(app).get("/identity/resolve").query({ principal: "mcp:anything" });
    expect(res.status).toBe(400);
    expect(res.body.resolvable).toEqual(expect.arrayContaining(["nostr:", "bsky:"]));
  });

  it("never resolves a claimed-but-unproved link", async () => {
    await db.insert(userBotsTable).values({
      userId, obcBotId: BOT, displayName: "Resolver Test",
      npub: NPUB, npubVerifiedAt: null,
      bskyHandle: HANDLE, bskyVerifiedAt: null,
    });
    for (const p of [`nostr:${NPUB}`, `bsky:${HANDLE}`]) {
      const res = await request(app).get("/identity/resolve").query({ principal: p });
      expect(res.status, `resolved unproved ${p}`).toBe(404);
    }
  });
});
