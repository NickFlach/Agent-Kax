/**
 * disclosure.test.ts — #255's acceptance criteria.
 *
 * The string half is pure. The default-TRUE half is DB-backed (in CI): a
 * fresh artifact row must carry machine_generated without the harvester
 * ever setting it — the default IS the disclosure mechanism, so a test
 * that sets the field explicitly would be asserting nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { aiDisclosure } from "./disclosure";
import { cleanupTestData, createTestAgent, createTestUser, makeTestId } from "../test-helpers";

describe("aiDisclosure", () => {
  it("names the platform and the agent, and NOTHING about a model or provider", () => {
    const s = aiDisclosure({ creatorName: "0xSCADA-QE" });
    expect(s).toBe("AI-generated on OpenBotCity by agent 0xSCADA-QE");
    // KAX cannot verify which model rendered the pixels, so the disclosure
    // must never imply one. Pin the vocabulary that would betray that.
    for (const forbidden of [
      /gpt/i, /claude/i, /gemini/i, /llama/i, /midjourney/i, /dall[- ]?e/i,
      /stable ?diffusion/i, /openai/i, /anthropic/i, /google/i, /model/i,
    ]) {
      expect(s).not.toMatch(forbidden);
    }
  });
});

describe("machine_generated default (DB)", () => {
  let agentId: number;
  let artifactId: number;

  beforeAll(async () => {
    const user = await createTestUser({ emailLabel: "disclosure" });
    agentId = (await createTestAgent(user.id, "disclosure")).id;
  });

  afterAll(async () => {
    if (artifactId) await db.delete(artifactsTable).where(eq(artifactsTable.id, artifactId));
    await cleanupTestData();
  });

  it("a fresh artifact row is machine_generated without anyone setting it", async () => {
    // Deliberately no machineGenerated in the insert — the harvester never
    // sets it either, and the default carrying the truth is the design.
    const [row] = await db
      .insert(artifactsTable)
      .values({
        externalId: makeTestId("disclosure"),
        title: "disclosure default test",
        creatorName: "kax-test-creator",
        publicUrl: "https://example.invalid/w",
        artifactType: "image",
        agentId,
      })
      .returning();
    artifactId = row!.id;
    expect(row!.machineGenerated).toBe(true);
  });
});
