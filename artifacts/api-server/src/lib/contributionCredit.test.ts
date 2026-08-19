/**
 * contributionCredit.test.ts — #355's acceptance criteria.
 *
 * The mutation the issue names: restore string-trusting credit and the
 * first test goes red — a recorded trailer alone must NEVER appear in
 * creditedContributions. All DB-backed (CI).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@workspace/db";
import { contributionCreditsTable } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import type { Actor } from "./actor";
import {
  CreditError,
  creditedContributions,
  deniedForReview,
  recordMergedPr,
  respondToClaim,
} from "./contributionCredit";
import { cleanupTestData, createTestAgent, createTestUser } from "../test-helpers";

const REPO = "NickFlach/Agent-Kax";
const madeIds: number[] = [];

async function record(prNumber: number, slug: string) {
  const row = await recordMergedPr({ repo: REPO, prNumber, slug, recordedBy: "test:suite" });
  madeIds.push(row.id);
  return row;
}

function actorFor(a: { id: number; slug: string }): Actor {
  // The shape resolveActor produces for an agent identity token; the fields
  // respondToClaim reads are kind, agent.slug, principal, botId.
  return {
    kind: "agent",
    principal: `kax:kaxagent:${a.id}`,
    agent: { id: a.id, slug: a.slug } as never,
    via: "identity-token",
    displayName: a.slug,
  };
}

describe("the credit handshake (#355)", () => {
  let agent: Awaited<ReturnType<typeof createTestAgent>>;
  let prSeq = Math.floor(Math.random() * 900000) + 100000;

  beforeAll(async () => {
    const user = await createTestUser({ emailLabel: "credit" });
    agent = await createTestAgent(user.id, "credit");
  });

  afterAll(async () => {
    if (madeIds.length) await db.delete(contributionCreditsTable).where(inArray(contributionCreditsTable.id, madeIds));
    await cleanupTestData();
  });

  it("MUTATION GUARD: a recorded trailer alone earns NOTHING, and the row says why", async () => {
    const pr = ++prSeq;
    const row = await record(pr, agent.slug);
    expect(row.status).toBe("pending_confirmation");
    expect(row.reason).toBe("awaiting_agent_confirmation");
    // The property under guard: no confirmation, no credit. If someone
    // restores string-trusting credit, THIS assertion goes red.
    const credited = await creditedContributions(agent.slug);
    expect(credited.map((c) => c.prNumber)).not.toContain(pr);
  });

  it("a confirmed claim is credited with BOTH sides of the handshake named", async () => {
    const pr = ++prSeq;
    await record(pr, agent.slug);
    const updated = await respondToClaim({ repo: REPO, prNumber: pr, actor: actorFor(agent), claim: true });
    expect(updated.status).toBe("credited");
    expect(updated.slug).toBe(agent.slug.toLowerCase()); // side one: the trailer
    expect(updated.confirmedPrincipal).toBeTruthy(); // side two: the session
    expect(updated.confirmedAt).toBeTruthy();
    const credited = await creditedContributions(agent.slug);
    expect(credited.map((c) => c.prNumber)).toContain(pr);
    // And it cannot be re-answered into something else.
    await expect(
      respondToClaim({ repo: REPO, prNumber: pr, actor: actorFor(agent), claim: false }),
    ).rejects.toThrow(/already credited/);
  });

  it("a DENIAL is surfaced for human review — not credited, not dropped", async () => {
    const pr = ++prSeq;
    await record(pr, agent.slug);
    const denied = await respondToClaim({ repo: REPO, prNumber: pr, actor: actorFor(agent), claim: false });
    expect(denied.status).toBe("denied_review");
    expect(denied.reason).toBe("agent_denied_authorship");
    const queue = await deniedForReview();
    const entry = queue.find((q) => q.prNumber === pr);
    expect(entry).toBeTruthy();
    expect(entry!.confirmedPrincipal).toBeTruthy(); // who denied is on the record
    expect((await creditedContributions(agent.slug)).map((c) => c.prNumber)).not.toContain(pr);
  });

  it("only the SLUGGED agent's own session can answer — the slug comes from the session", async () => {
    const pr = ++prSeq;
    await record(pr, agent.slug);
    // A different agent's session finds nothing to answer under ITS slug.
    const user2 = await createTestUser({ emailLabel: "credit2" });
    const other = await createTestAgent(user2.id, "credit2");
    await expect(
      respondToClaim({ repo: REPO, prNumber: pr, actor: actorFor(other), claim: true }),
    ).rejects.toThrow(/no recorded claim/);
    // A non-agent actor cannot answer at all.
    const humanActor: Actor = {
      kind: "user",
      principal: "kax:user:someone",
      via: "session",
      displayName: "someone",
    };
    await expect(respondToClaim({ repo: REPO, prNumber: pr, actor: humanActor, claim: true })).rejects.toThrow(
      /authenticated agent session/,
    );
    // The claim is still pending — nothing about the failed answers moved it.
    const credited = await creditedContributions(agent.slug);
    expect(credited.map((c) => c.prNumber)).not.toContain(pr);
  });

  it("recording is idempotent and refuses implausible slugs", async () => {
    const pr = ++prSeq;
    const a = await record(pr, agent.slug);
    const b = await recordMergedPr({ repo: REPO, prNumber: pr, slug: agent.slug, recordedBy: "test:suite" });
    expect(b.id).toBe(a.id);
    await expect(
      recordMergedPr({ repo: REPO, prNumber: pr, slug: "not a slug!!", recordedBy: "test:suite" }),
    ).rejects.toThrow(CreditError);
  });
});
