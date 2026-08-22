/**
 * predictionLeaderboard.test.ts — one board across both prediction systems,
 * keyed on the KAX principal (#409).
 *
 * DB-backed for the identity map (real agents rows), with the hub fetch mocked
 * so the test does not depend on the live GhostSignals hub.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { agentsTable, usersTable } from "@workspace/db/schema";
import { unifiedLeaderboard, forecastRecord, type HubTrader } from "./predictionLeaderboard";

function hubFetch(traders: HubTrader[]): typeof fetch {
  const impl = async (): Promise<Response> =>
    ({ ok: true, json: async () => ({ ok: true, traders }) }) as unknown as Response;
  return impl as unknown as typeof fetch;
}

let seq = 0;
let uniq = 0;

describe("unified prediction leaderboard (#409)", () => {
  beforeEach(async () => {
    seq += 100;
    await db.execute(sql`DELETE FROM agents WHERE slug LIKE 'lb-test-%'`);
  });

  async function seedAgent(slug: string, displayName: string, obcBotId: string) {
    const [u] = await db.insert(usersTable).values({ email: `lb-${++uniq}-${Date.now()}@t.test` }).returning({ id: usersTable.id });
    await db.insert(agentsTable).values({ slug, displayName, obcBotId, ownerId: u.id });
  }

  it("federates the hub board and keys each trader on its KAX principal", async () => {
    const bot = "b757bd93-6993-400b-9dd4-9d38bf257c67";
    await seedAgent(`lb-test-scada-${seq}`, "0xSCADA-QE", bot);
    const board = await unifiedLeaderboard(
      hubFetch([
        { id: "b757bd93", display_name: "0xSCADA-QE", capital: 500, reputation: 0.9, trades_total: 20, accuracy: 0.8 },
        { id: "stranger-hex-01", display_name: "Someone Unmapped", capital: 100, reputation: 0.5, trades_total: 1 },
      ]),
    );
    const scada = board.traders.find((t) => t.hubId === "b757bd93");
    expect(scada?.kaxPrincipal).toBe(`kax:agent:${bot}`);
    expect(scada?.accuracy).toBeCloseTo(0.8, 2);
    // Unmapped traders are still shown, honestly, with a null principal.
    const stranger = board.traders.find((t) => t.hubId === "stranger-hex-01");
    expect(stranger?.kaxPrincipal).toBeNull();
    expect(board.source).toBe("ghostsignals+kax-labs");
  });

  it("resolves by display name when the id is not a bot fragment", async () => {
    await seedAgent(`lb-test-flau-${seq}`, "Flaukowski", "0c4783c9-9920-4ea0-bc5b-46a571d471fa");
    const board = await unifiedLeaderboard(hubFetch([{ id: "2babfe41d757", display_name: "Flaukowski", capital: 100 }]));
    expect(board.traders[0].kaxPrincipal).toBe("kax:agent:0c4783c9-9920-4ea0-bc5b-46a571d471fa");
  });

  it("retrieves one agent's forecast record by its KAX principal", async () => {
    const bot = "0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7";
    await seedAgent(`lb-test-kan-${seq}`, "Kannaka", bot);
    const record = await forecastRecord(
      `kax:agent:${bot}`,
      hubFetch([{ id: "0f05e10b", display_name: "Kannaka", capital: 999, reputation: 1, trades_total: 5, accuracy: 1 }]),
    );
    expect(record?.name).toBe("Kannaka");
    expect(record?.capital).toBe(999);
  });

  it("returns null for a principal on neither board", async () => {
    const record = await forecastRecord("kax:agent:ffffffff-ffff-ffff-ffff-ffffffffffff", hubFetch([]));
    expect(record).toBeNull();
  });
});
