import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { operatorApprovalsTable, usersTable, type OperatorApproval } from "@workspace/db/schema";
import { sendNotificationEmail } from "./notify";
import { logger } from "./logger";
import {
  getApprovalHandler,
  isValidDecision,
  type ApprovalDecision,
  type ApprovalRow,
} from "./operator-approvals-core";

/**
 * The operator approval inbox (db-backed). Everything that must wait on a
 * human — a tower tenancy application, a radio ad, an analytics signup —
 * calls requestApproval; the operator sees it in the dashboard and decides;
 * decideApproval flips it and dispatches to the kind's registered handler.
 */

export class ApprovalNotFound extends Error {
  readonly code = "approval_not_found";
}
export class ApprovalAlreadyDecided extends Error {
  readonly code = "approval_already_decided";
  constructor(public readonly status: string) {
    super(`approval already ${status}`);
  }
}
export class BadDecision extends Error {
  readonly code = "bad_decision";
}

export interface RequestApprovalInput {
  kind: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  requestedBy?: string;
  /** Idempotency: a resubmit with the same key returns the existing pending row. */
  dedupeKey?: string;
}

/**
 * Raise something for the operator to approve, and notify. Idempotent on
 * dedupeKey: a resubmitted application returns the existing pending row rather
 * than opening a second (the partial unique index is the backstop). Notify is
 * best-effort — a missing SendGrid key must never fail the request, because
 * the dashboard panel is the primary channel and email is the convenience.
 */
export async function requestApproval(input: RequestApprovalInput): Promise<{ id: number; deduped: boolean }> {
  if (input.dedupeKey) {
    const [existing] = await db
      .select({ id: operatorApprovalsTable.id })
      .from(operatorApprovalsTable)
      .where(and(
        eq(operatorApprovalsTable.dedupeKey, input.dedupeKey),
        eq(operatorApprovalsTable.status, "pending"),
      ))
      .limit(1);
    if (existing) return { id: existing.id, deduped: true };
  }
  let row: OperatorApproval;
  try {
    [row] = await db
      .insert(operatorApprovalsTable)
      .values({
        kind: input.kind,
        title: input.title.slice(0, 300),
        body: input.body?.slice(0, 4000) ?? null,
        payload: input.payload ?? {},
        requestedBy: input.requestedBy?.slice(0, 200) ?? null,
        dedupeKey: input.dedupeKey ?? null,
      })
      .returning() as [OperatorApproval];
  } catch (e) {
    // Lost a race on the pending-dedupe unique index — the other writer's row
    // is the canonical one.
    if ((e as { code?: string })?.code === "23505" && input.dedupeKey) {
      const [existing] = await db
        .select({ id: operatorApprovalsTable.id })
        .from(operatorApprovalsTable)
        .where(and(
          eq(operatorApprovalsTable.dedupeKey, input.dedupeKey),
          eq(operatorApprovalsTable.status, "pending"),
        ))
        .limit(1);
      if (existing) return { id: existing.id, deduped: true };
    }
    throw e;
  }
  void notifyOperators(input.kind, input.title).catch((err) =>
    logger.warn({ err, kind: input.kind }, "operator-approval notify failed (best-effort)"),
  );
  return { id: row.id, deduped: false };
}

async function notifyOperators(kind: string, title: string): Promise<void> {
  const admins = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.role, "admin"));
  const base = process.env.PUBLIC_APP_URL ?? "https://kax.ninja-portal.com";
  for (const a of admins) {
    if (!a.email) continue;
    await sendNotificationEmail({
      to: a.email,
      subject: `KAX approval needed: ${title}`,
      text: `A ${kind} is waiting for your approval.\n\n${title}\n\nReview it in your dashboard: ${base}/dashboard`,
    });
  }
}

export async function listApprovals(status: "pending" | "approved" | "rejected" | "all" = "pending", limit = 100): Promise<OperatorApproval[]> {
  const q = db.select().from(operatorApprovalsTable).orderBy(desc(operatorApprovalsTable.id)).limit(Math.min(limit, 200));
  if (status === "all") return await q;
  return await q.where(eq(operatorApprovalsTable.status, status));
}

export interface DecideResult {
  id: number;
  decision: ApprovalDecision;
  executed: boolean;
  executionError: string | null;
}

/**
 * Decide an approval. The pending→decided flip is a conditional UPDATE that
 * only one caller can win, so a stale tab or a retry cannot re-decide (and
 * cannot double-run the handler). The winner then dispatches to the kind's
 * handler: a handler failure does NOT un-decide — the decision is the
 * operator's and stands — but is reported so the action can be re-driven.
 */
export async function decideApproval(
  id: number,
  decision: ApprovalDecision,
  decidedBy: string,
  note?: string,
): Promise<DecideResult> {
  if (!isValidDecision(decision)) throw new BadDecision(`decision must be "approved" or "rejected"`);

  const [row] = await db
    .update(operatorApprovalsTable)
    .set({ status: decision, decidedBy: decidedBy.slice(0, 200), decisionNote: note?.slice(0, 2000) ?? null, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(operatorApprovalsTable.id, id), eq(operatorApprovalsTable.status, "pending")))
    .returning();

  if (!row) {
    // Either it doesn't exist, or it's already decided — distinguish for a
    // clean status code, but only after the CAS so the two callers can't both
    // proceed.
    const [existing] = await db.select().from(operatorApprovalsTable).where(eq(operatorApprovalsTable.id, id)).limit(1);
    if (!existing) throw new ApprovalNotFound(`approval ${id} not found`);
    throw new ApprovalAlreadyDecided(existing.status);
  }

  const handler = getApprovalHandler(row.kind);
  const fn = decision === "approved" ? handler?.onApprove : handler?.onReject;
  if (!fn) return { id, decision, executed: false, executionError: null };

  const approval: ApprovalRow = {
    id: row.id, kind: row.kind, status: row.status, title: row.title, body: row.body, payload: row.payload, requestedBy: row.requestedBy,
  };
  try {
    await fn(approval);
    return { id, decision, executed: true, executionError: null };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    logger.error({ err: e, id, kind: row.kind, decision }, "operator-approval handler failed (decision stands)");
    return { id, decision, executed: false, executionError: msg };
  }
}
