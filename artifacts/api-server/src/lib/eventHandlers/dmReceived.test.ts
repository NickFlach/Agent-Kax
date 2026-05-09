import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { dmsTable } from "@workspace/db/schema";
import { handleDmReceived } from "./dmReceived";
import {
  cleanupTestData,
  createTestAgent,
  createTestUser,
  makeUuid,
  testLogger,
} from "../../test-helpers";

const ctx = { log: testLogger, source: "webhook" as const };

describe("handleDmReceived", () => {
  beforeEach(async () => {
    await cleanupTestData();
  });
  afterAll(async () => {
    await cleanupTestData();
  });

  it("ignores payloads with no uuid", async () => {
    const before = await db.select().from(dmsTable);
    await handleDmReceived({ body: "no uuid here" }, ctx);
    const after = await db.select().from(dmsTable);
    expect(after.length).toBe(before.length);
  });

  it("routes to a known recipient agent", async () => {
    const owner = await createTestUser();
    const agent = await createTestAgent(owner.id, "dm-recipient");
    const sourceUuid = makeUuid();

    await handleDmReceived(
      {
        dm_uuid: sourceUuid,
        to_agent_slug: agent.slug,
        from_agent_slug: "pen-pal",
        from_display_name: "Pen Pal",
        body: "hello there",
      },
      ctx,
    );

    const [row] = await db
      .select()
      .from(dmsTable)
      .where(eq(dmsTable.sourceUuid, sourceUuid));
    expect(row).toBeDefined();
    expect(row.agentId).toBe(agent.id);
    expect(row.ownerId).toBe(owner.id);
    expect(row.fromDisplayName).toBe("Pen Pal");
    expect(row.body).toBe("hello there");
    expect(row.readAt).toBeNull();
  });

  it("stores unrouted when recipient slug is unknown", async () => {
    const sourceUuid = makeUuid();
    await handleDmReceived(
      {
        uuid: sourceUuid,
        recipient_slug: "kax-test-nope-no-such-agent",
        body: "stranded",
      },
      ctx,
    );

    const [row] = await db
      .select()
      .from(dmsTable)
      .where(eq(dmsTable.sourceUuid, sourceUuid));
    expect(row).toBeDefined();
    expect(row.agentId).toBeNull();
    expect(row.ownerId).toBeNull();
    expect(row.body).toBe("stranded");
  });

  it("dedupes on source_uuid", async () => {
    const owner = await createTestUser();
    const agent = await createTestAgent(owner.id, "dm-dedupe");
    const sourceUuid = makeUuid();
    const payload = {
      dm_uuid: sourceUuid,
      to_agent_slug: agent.slug,
      body: "first",
    };

    await handleDmReceived(payload, ctx);
    await handleDmReceived({ ...payload, body: "second" }, ctx);

    const rows = await db
      .select()
      .from(dmsTable)
      .where(eq(dmsTable.sourceUuid, sourceUuid));
    expect(rows.length).toBe(1);
    expect(rows[0].body).toBe("first");
  });

  it("accepts alias payload shape and falls back body=''", async () => {
    const owner = await createTestUser();
    const agent = await createTestAgent(owner.id, "dm-alias");
    const sourceUuid = makeUuid();

    await handleDmReceived(
      {
        uuid: sourceUuid,
        recipient_slug: agent.slug,
        sender_slug: "alias-sender",
        sender_display_name: "Alias Sender",
        message: "via message field",
      },
      ctx,
    );

    const [aliased] = await db
      .select()
      .from(dmsTable)
      .where(eq(dmsTable.sourceUuid, sourceUuid));
    expect(aliased.fromAgentSlug).toBe("alias-sender");
    expect(aliased.fromDisplayName).toBe("Alias Sender");
    expect(aliased.body).toBe("via message field");

    const emptyUuid = makeUuid();
    await handleDmReceived(
      { uuid: emptyUuid, recipient_slug: agent.slug },
      ctx,
    );
    const [empty] = await db
      .select()
      .from(dmsTable)
      .where(eq(dmsTable.sourceUuid, emptyUuid));
    expect(empty.body).toBe("");
  });
});
