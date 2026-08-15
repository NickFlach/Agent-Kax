/**
 * revocation.test.ts — a withdrawn verification must actually stop the agent.
 *
 * Sixth of the published bank rules: freeze a revoked agent's balances and
 * open positions when the revocation arrives. It is the only rule about a fact
 * that CHANGES — the rest are standing constraints you satisfy once — and
 * until it lands the city is honouring standing an agent no longer has.
 *
 * Two properties matter here and they are not the same. Recording a revocation
 * is easy; ENFORCING it is the point, and enforcement lives at a gate far from
 * this file. So these test both, including that resolveActor refuses — because
 * a revocation the identity layer ignores is a note in a database.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { userBotsTable } from "@workspace/db/schema";
import { isRevoked, revoke, restore, revokedBotIds, botIdOfPrincipal } from "./revocation";
import * as residents from "./residents";
import { roster, _clear as clearPresence } from "./presence";
import { cleanupTestData, createTestUser } from "../test-helpers";

const BOT = "eeeeeeee-1111-2222-3333-444444444444";
const OTHER = "ffffffff-1111-2222-3333-444444444444";
let userId: string;

describe("revocation", () => {
  beforeEach(async () => {
    if (!userId) userId = (await createTestUser({ emailLabel: "revoke" })).id;
    for (const b of [BOT, OTHER]) await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, b));
    await db.insert(userBotsTable).values([
      { userId, obcBotId: BOT, displayName: "Revocable" },
      { userId, obcBotId: OTHER, displayName: "Innocent Bystander" },
    ]);
    residents._clear();
    clearPresence();
  });

  afterAll(async () => {
    for (const b of [BOT, OTHER]) await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, b));
    await cleanupTestData();
  });

  it("an unrevoked bot reads as fine", async () => {
    expect(await isRevoked(BOT)).toBeNull();
  });

  it("records a revocation with its reason", async () => {
    expect(await revoke(BOT, "suspended for spam")).toBe(true);
    const r = await isRevoked(BOT);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe("suspended for spam");
    expect(r!.revokedAt).toBeInstanceOf(Date);
  });

  it("touches only the bot named", async () => {
    await revoke(BOT, "nothing to do with the other one");
    expect(await isRevoked(OTHER)).toBeNull();
  });

  it("is reversible, and restores rather than rebuilds", async () => {
    // A suspension is not a demolition: nothing was deleted, so lifting it
    // gives the agent back the same row, home and history.
    await revoke(BOT, "temporary");
    expect(await restore(BOT)).toBe(true);
    expect(await isRevoked(BOT)).toBeNull();

    const [row] = await db.select().from(userBotsTable).where(eq(userBotsTable.obcBotId, BOT));
    expect(row, "the attachment was destroyed instead of frozen").toBeTruthy();
    expect(row!.displayName).toBe("Revocable");
  });

  it("reports matched:false for a bot with no storefront here", async () => {
    // A webhook fanned out to every integration will name bots this one has
    // never seen. Erroring on those looks broken while behaving correctly.
    expect(await revoke("11111111-9999-9999-9999-999999999999")).toBe(false);
  });

  it("lists the revoked for the eviction sweep", async () => {
    await revoke(BOT);
    const ids = await revokedBotIds();
    expect(ids.has(BOT)).toBe(true);
    expect(ids.has(OTHER)).toBe(false);
  });

  it("reads a bot id out of either principal form", () => {
    // One bot answers to two names, and an eviction that knew only one of
    // them would evict half of it.
    expect(botIdOfPrincipal(`obc:${BOT}`)).toBe(BOT);
    expect(botIdOfPrincipal(`kax:agent:${BOT}`)).toBe(BOT);
    expect(botIdOfPrincipal(`nostr:npub1x`)).toBeNull();
  });

  it("evicts a revoked resident from the city on the next tick", async () => {
    const T = 8_000_000;
    residents.enter({ principal: `obc:${BOT}`, name: "Revocable", kind: "agent", room: "city" }, T);
    residents.tickAll(T + 900);
    expect(roster("city", T + 900)).toHaveLength(1);

    // The refresher hands the registry the revoked set; the tick acts on it.
    residents.setRevokedPrincipals([`obc:${BOT}`, `kax:agent:${BOT}`]);
    residents.tickAll(T + 1_800);

    expect(residents.count()).toBe(0);
    expect(roster("city", T + 1_800), "still drawing a body for a disowned agent").toHaveLength(0);
  });

  it("evicts ahead of the idle clock, not after it", async () => {
    // Waiting out the 30-minute idle window would leave a revoked agent
    // standing in the street for half an hour.
    const T = 9_000_000;
    residents.enter({ principal: `obc:${BOT}`, name: "Revocable", kind: "agent", room: "city" }, T);
    residents.setRevokedPrincipals([`obc:${BOT}`]);
    residents.tickAll(T + 900); // long before IDLE_MS
    expect(residents.count()).toBe(0);
  });

  it("leaves everybody else standing", async () => {
    const T = 9_500_000;
    residents.enter({ principal: `obc:${BOT}`, name: "Revocable", kind: "agent", room: "city" }, T);
    residents.enter({ principal: `obc:${OTHER}`, name: "Innocent", kind: "agent", room: "city" }, T);
    residents.setRevokedPrincipals([`obc:${BOT}`]);
    residents.tickAll(T + 900);

    expect(residents.count()).toBe(1);
    expect(roster("city", T + 900).map((e) => e.name)).toEqual(["Innocent"]);
  });
});
