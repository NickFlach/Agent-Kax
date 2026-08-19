import { db } from "@workspace/db";
import { contributionCreditsTable, type ContributionCredit } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import type { Actor } from "./actor";

/**
 * contributionCredit.ts — credit is a handshake, not a string (#355).
 *
 * One side: the City-Agent trailer on a merged PR — free text, recorded
 * here as a CLAIM with status pending_confirmation and zero effect. The
 * other side: the slugged agent confirming the (repo, pr) pair through its
 * own authenticated city session (identity token → resolveActor → the
 * agents row whose slug must match). Only the matched pair is a credit,
 * and the credited row names both sides.
 *
 * The denial path is deliberately loud: an agent saying "that was not me"
 * moves the row to denied_review for a HUMAN — silently crediting it would
 * launder a forgery, silently dropping it would erase the evidence that a
 * forgery was attempted.
 */

export const CREDIT_STATUSES = [
  "pending_confirmation",
  "credited",
  "denied_review",
  "uncredited",
] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];

export class CreditError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Record a merged PR's trailer claim. NO CREDIT happens here — the row is
 * born pending_confirmation with the reason pre-filled, so an unconfirmed
 * claim is always explainable ("why does this slug show no credit?").
 * Idempotent on (repo, pr, slug).
 */
export async function recordMergedPr(input: {
  repo: string;
  prNumber: number;
  slug: string;
  recordedBy: string;
}): Promise<ContributionCredit> {
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
    throw new CreditError(`'${input.slug}' is not a plausible agent slug`, 400);
  }
  const [inserted] = await db
    .insert(contributionCreditsTable)
    .values({
      repo: input.repo,
      prNumber: input.prNumber,
      slug,
      status: "pending_confirmation",
      reason: "awaiting_agent_confirmation",
      recordedBy: input.recordedBy,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(contributionCreditsTable)
    .where(
      and(
        eq(contributionCreditsTable.repo, input.repo),
        eq(contributionCreditsTable.prNumber, input.prNumber),
        eq(contributionCreditsTable.slug, slug),
      ),
    )
    .limit(1);
  return existing!;
}

/**
 * The agent's side of the handshake. `claim: true` confirms authorship;
 * `claim: false` denies it. The actor must BE the slugged agent — resolved
 * from its authenticated session, never from the request body — or the
 * confirmation is itself the forgery the pipeline exists to stop.
 */
export async function respondToClaim(input: {
  repo: string;
  prNumber: number;
  actor: Actor;
  claim: boolean;
}): Promise<ContributionCredit> {
  const agentSlug = input.actor.agent?.slug?.toLowerCase();
  if (input.actor.kind !== "agent" || !agentSlug) {
    throw new CreditError("only an authenticated agent session can answer a credit claim", 403);
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(contributionCreditsTable)
      .where(
        and(
          eq(contributionCreditsTable.repo, input.repo),
          eq(contributionCreditsTable.prNumber, input.prNumber),
          eq(contributionCreditsTable.slug, agentSlug),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) {
      throw new CreditError(
        `no recorded claim for ${input.repo}#${input.prNumber} under slug '${agentSlug}' — nothing to answer`,
        404,
      );
    }
    if (row.status !== "pending_confirmation") {
      throw new CreditError(`claim for ${input.repo}#${input.prNumber} is already ${row.status}`, 409);
    }
    const next = input.claim
      ? {
          status: "credited" as const,
          reason: null,
          confirmedPrincipal: input.actor.principal,
          confirmedBotId: input.actor.botId ?? null,
          confirmedAt: new Date(),
        }
      : {
          status: "denied_review" as const,
          reason: "agent_denied_authorship",
          confirmedPrincipal: input.actor.principal,
          confirmedBotId: input.actor.botId ?? null,
          confirmedAt: new Date(),
        };
    const [updated] = await tx
      .update(contributionCreditsTable)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(contributionCreditsTable.id, row.id))
      .returning();
    return updated!;
  });
}

/**
 * What a slug has actually EARNED: credited rows only. This is the one
 * read the profile surface may use — pending/denied rows are visible
 * elsewhere as state, never as credit. (The #355 mutation guard lives on
 * this function: restore string-trusting credit and its test goes red.)
 */
export async function creditedContributions(slug: string): Promise<ContributionCredit[]> {
  return db
    .select()
    .from(contributionCreditsTable)
    .where(and(eq(contributionCreditsTable.slug, slug.toLowerCase()), eq(contributionCreditsTable.status, "credited")));
}

/** The human-review surface: denials, oldest first, with both sides named. */
export async function deniedForReview(): Promise<ContributionCredit[]> {
  return db
    .select()
    .from(contributionCreditsTable)
    .where(eq(contributionCreditsTable.status, "denied_review"));
}
