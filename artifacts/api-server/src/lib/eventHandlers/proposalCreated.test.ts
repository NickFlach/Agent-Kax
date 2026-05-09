import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { proposalsTable, activitiesTable } from "@workspace/db/schema";
import { handleProposalCreated } from "./proposalCreated";
import {
  cleanupTestData,
  createTestAgent,
  createTestUser,
  makeUuid,
  testLogger,
} from "../../test-helpers";

const ctx = { log: testLogger, source: "webhook" as const };

describe("handleProposalCreated", () => {
  beforeEach(async () => {
    await cleanupTestData();
  });
  afterAll(async () => {
    await cleanupTestData();
  });

  it("ignores payloads with no uuid", async () => {
    const before = await db.select().from(proposalsTable);
    await handleProposalCreated({ subject: "no uuid" }, ctx);
    const after = await db.select().from(proposalsTable);
    expect(after.length).toBe(before.length);
  });

  it("routes to a known recipient agent and inserts an activity", async () => {
    const owner = await createTestUser();
    const agent = await createTestAgent(owner.id, "recipient");
    const sourceUuid = makeUuid();

    await handleProposalCreated(
      {
        proposal_uuid: sourceUuid,
        to_agent_slug: agent.slug,
        from_agent_slug: "stranger",
        from_display_name: "Stranger Bot",
        kind: "collab",
        subject: "Hi",
        body: "Want to collab?",
      },
      ctx,
    );

    const [row] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.sourceUuid, sourceUuid));
    expect(row).toBeDefined();
    expect(row.agentId).toBe(agent.id);
    expect(row.ownerId).toBe(owner.id);
    expect(row.kind).toBe("collab");
    expect(row.subject).toBe("Hi");
    expect(row.body).toBe("Want to collab?");
    expect(row.status).toBe("pending");

    const acts = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.ownerId, owner.id));
    expect(acts.length).toBe(1);
    expect(acts[0].message).toContain("Proposal received");
    expect(acts[0].message).toContain("Stranger Bot");
  });

  it("stores unrouted when recipient slug is unknown and writes no activity", async () => {
    const sourceUuid = makeUuid();
    await handleProposalCreated(
      {
        uuid: sourceUuid,
        recipient_slug: "kax-test-nope-does-not-exist",
        sender_slug: "ghost",
      },
      ctx,
    );

    const [row] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.sourceUuid, sourceUuid));
    expect(row).toBeDefined();
    expect(row.agentId).toBeNull();
    expect(row.ownerId).toBeNull();
    expect(row.fromAgentSlug).toBe("ghost");

    const acts = await db.select().from(activitiesTable);
    expect(acts.find((a) => a.message?.includes("Proposal received"))).toBeUndefined();
  });

  it("dedupes on source_uuid and does not double-write activity", async () => {
    const owner = await createTestUser();
    const agent = await createTestAgent(owner.id, "dedupe");
    const sourceUuid = makeUuid();
    const payload = {
      proposal_uuid: sourceUuid,
      to_agent_slug: agent.slug,
      subject: "First",
    };

    await handleProposalCreated(payload, ctx);
    await handleProposalCreated({ ...payload, subject: "Second" }, ctx);

    const rows = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.sourceUuid, sourceUuid));
    expect(rows.length).toBe(1);
    expect(rows[0].subject).toBe("First");

    const acts = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.ownerId, owner.id));
    expect(acts.length).toBe(1);
  });

  it("accepts the alias payload shape (uuid / recipient_slug / sender_*)", async () => {
    const owner = await createTestUser();
    const agent = await createTestAgent(owner.id, "alias");
    const sourceUuid = makeUuid();

    await handleProposalCreated(
      {
        uuid: sourceUuid,
        recipient_slug: agent.slug,
        sender_slug: "alias-sender",
        sender_display_name: "Alias Sender",
        message: "via alias",
      },
      ctx,
    );

    const [row] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.sourceUuid, sourceUuid));
    expect(row).toBeDefined();
    expect(row.agentId).toBe(agent.id);
    expect(row.fromAgentSlug).toBe("alias-sender");
    expect(row.fromDisplayName).toBe("Alias Sender");
    expect(row.body).toBe("via alias");
  });
});
