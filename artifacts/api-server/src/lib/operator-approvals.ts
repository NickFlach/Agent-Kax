import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { operatorApprovalsTable, usersTable, type OperatorApproval } from "@workspace/db/schema";
import { sendNotificationEmail } from "./notify";
import { logger } from "./logger";
import {
  assertRequiredHandlers,
  getApprovalHandler,
  isHandlerRequiredKind,
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
export class AlreadyExecuted extends Error {
  readonly code = "already_executed";
}
export class ExecutionInFlight extends Error {
  readonly code = "execution_in_flight";
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

export type ListStatus = "pending" | "approved" | "rejected" | "all" | "needs_action";

export async function listApprovals(status: ListStatus = "pending", limit = 100): Promise<OperatorApproval[]> {
  const base = db.select().from(operatorApprovalsTable).orderBy(desc(operatorApprovalsTable.id)).limit(Math.min(limit, 200));
  // "needs_action" = decided but its side-effect hasn't run — the queue the
  // dashboard surfaces for a stuck refund/go-live. A precise server query, not
  // a client-side filter over a capped "all" page (which could miss an old one).
  if (status === "needs_action") {
    return await base.where(and(
      inArray(operatorApprovalsTable.status, ["approved", "rejected"]),
      eq(operatorApprovalsTable.executed, false),
    ));
  }
  if (status === "all") return await base;
  return await base.where(eq(operatorApprovalsTable.status, status));
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

  // The CAS also stamps next_execute_at = now, so the row enters the execution
  // queue the instant it is decided. runHandler (below) resolves it — on
  // success to executed=true, on failure to a backoff — and if THIS request
  // dies before runHandler writes anything, the row is left decided +
  // executed=false + next_execute_at<=now, which is exactly what the sweeper
  // reclaims. No decided row can strand.
  const [row] = await db
    .update(operatorApprovalsTable)
    .set({ status: decision, decidedBy: decidedBy.slice(0, 200), decisionNote: note?.slice(0, 2000) ?? null, decidedAt: new Date(), nextExecuteAt: new Date(), leaseUntil: null, updatedAt: new Date() })
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

  // Claim the fresh row (lease) before running, so a sweep firing in the same
  // second can't also run the handler. claim() always wins here (the row is
  // due, unclaimed) but going through the one claim path keeps the concurrency
  // model single-sourced.
  const claimed = await claimForExecution(id);
  const out = claimed ? await runHandler(claimed) : { executed: false, executionError: "claimed by sweeper" };
  return { id, decision, executed: out.executed, executionError: out.executionError };
}

/** Backoff for a failed handler re-drive: 1m, 2m, 4m … capped at ~1h. */
function executeBackoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

/** How long a claim holds a row before the sweeper may reclaim it — the bound
 *  on how long a crashed runner strands its row. Handlers MUST finish well
 *  inside this (a Stripe call with a bounded client timeout does); a handler
 *  slower than the lease would be reclaimed and double-run. */
const EXECUTION_LEASE_MS = 5 * 60_000;

/**
 * Atomically claim a decided-but-unexecuted row for a single runner, by
 * setting lease_until forward. Claimable only when the row is DUE (backoff
 * elapsed or never attempted) AND not currently leased (no live runner, or a
 * prior lease expired = crashed runner). Exactly one caller wins the
 * conditional UPDATE; a concurrent claimer re-evaluates against the committed
 * lease and matches 0 rows. Returns the claimed row or null.
 */
async function claimForExecution(id: number, now: Date = new Date()): Promise<OperatorApproval | null> {
  const [claimed] = await db
    .update(operatorApprovalsTable)
    .set({ leaseUntil: new Date(now.getTime() + EXECUTION_LEASE_MS), updatedAt: now })
    .where(and(
      eq(operatorApprovalsTable.id, id),
      eq(operatorApprovalsTable.executed, false),
      inArray(operatorApprovalsTable.status, ["approved", "rejected"]),
      or(isNull(operatorApprovalsTable.nextExecuteAt), lte(operatorApprovalsTable.nextExecuteAt, now)),
      or(isNull(operatorApprovalsTable.leaseUntil), lte(operatorApprovalsTable.leaseUntil, now)),
    ))
    .returning();
  return claimed ?? null;
}


/**
 * Run the kind's handler for a CLAIMED row and persist the outcome. The
 * handler MUST be idempotent — this is at-least-once: a handler that succeeded
 * but whose ack was lost, or whose runner crashed after the effect, will be
 * re-invoked after the lease expires. On success the row is terminal
 * (executed=true, next_execute_at cleared); on failure it is re-queued with a
 * backoff. A decision whose kind has no matching handler is executed by
 * definition (nothing to run).
 *
 * The decision itself is never touched here — it stands regardless. Only the
 * execution bookkeeping moves.
 */
async function runHandler(row: OperatorApproval): Promise<{ executed: boolean; executionError: string | null }> {
  const handler = getApprovalHandler(row.kind);
  const fn = row.status === "approved" ? handler?.onApprove : handler?.onReject;
  if (!fn) {
    // A money kind with no registered handler is NOT "done" — silently marking
    // it executed would record a refund/go-live that never happened (a missed
    // import or load-order bug becomes silent money loss). Keep it unexecuted
    // and retrying so it stays visible until the handler is present. A
    // non-money kind (or one whose handler legitimately omits this decision's
    // side) genuinely has nothing to run.
    if (isHandlerRequiredKind(row.kind)) {
      return await recordFailure(row, `no handler registered for money kind "${row.kind}"`);
    }
    await db
      .update(operatorApprovalsTable)
      .set({ executed: true, executionError: null, nextExecuteAt: null, leaseUntil: null, updatedAt: new Date() })
      .where(eq(operatorApprovalsTable.id, row.id));
    return { executed: true, executionError: null };
  }
  const approval: ApprovalRow = {
    id: row.id, kind: row.kind, status: row.status, title: row.title, body: row.body, payload: row.payload, requestedBy: row.requestedBy,
  };
  try {
    await fn(approval);
    await db
      .update(operatorApprovalsTable)
      .set({ executed: true, executionError: null, nextExecuteAt: null, leaseUntil: null, updatedAt: new Date() })
      .where(eq(operatorApprovalsTable.id, row.id));
    return { executed: true, executionError: null };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    logger.error({ err: e, id: row.id, kind: row.kind, status: row.status }, "operator-approval handler failed (decision stands; will retry)");
    return await recordFailure(row, msg);
  }
}

/** Requeue a failed/unrunnable row with a backoff and release its lease. */
async function recordFailure(row: OperatorApproval, msg: string): Promise<{ executed: false; executionError: string }> {
  const attempts = row.executionAttempts + 1;
  await db
    .update(operatorApprovalsTable)
    .set({
      executed: false,
      executionError: msg.slice(0, 500),
      executionAttempts: attempts,
      nextExecuteAt: new Date(Date.now() + executeBackoffMs(attempts)),
      leaseUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(operatorApprovalsTable.id, row.id));
  return { executed: false, executionError: msg.slice(0, 500) };
}

/**
 * Re-drive a decided-but-unexecuted approval. The operator's manual override
 * for the auto-sweeper. CAS-locked on executed=false so two concurrent
 * re-executes (or a re-execute racing the sweeper) cannot both run the handler
 * — only the caller that flips the guard proceeds; the handler's own
 * idempotency covers the rest.
 */
export async function reExecuteApproval(id: number): Promise<DecideResult> {
  const now = new Date();
  // Force the backoff wait to end NOW, but only for a row that is NOT currently
  // leased by a live runner (lease_until null or expired). Because lease_until
  // is separate from next_execute_at, this cleanly distinguishes "waiting on a
  // backoff" (force-drivable, any distance out) from "a runner has it right
  // now" (must not be yanked) — closing both the double-run and the
  // short-backoff no-op the single-field version had.
  await db
    .update(operatorApprovalsTable)
    .set({ nextExecuteAt: now, updatedAt: now })
    .where(and(
      eq(operatorApprovalsTable.id, id),
      eq(operatorApprovalsTable.executed, false),
      inArray(operatorApprovalsTable.status, ["approved", "rejected"]),
      or(isNull(operatorApprovalsTable.leaseUntil), lte(operatorApprovalsTable.leaseUntil, now)),
    ));
  const claimed = await claimForExecution(id, now);
  if (!claimed) {
    const [existing] = await db.select().from(operatorApprovalsTable).where(eq(operatorApprovalsTable.id, id)).limit(1);
    if (!existing) throw new ApprovalNotFound(`approval ${id} not found`);
    if (existing.status === "pending") throw new ApprovalAlreadyDecided("pending");
    if (existing.executed) throw new AlreadyExecuted(`approval ${id} already executed`);
    // Not executed, not claimable → a live runner holds the lease right now.
    throw new ExecutionInFlight(`approval ${id} is being run right now — it will finish or retry on its own`);
  }
  const out = await runHandler(claimed);
  return { id, decision: claimed.status as ApprovalDecision, executed: out.executed, executionError: out.executionError };
}

/**
 * Auto-sweeper: re-drive every decided-but-unexecuted approval whose retry is
 * due. This is what keeps a rejected customer's refund from waiting on an
 * operator noticing a flag — correctness of money handlers must not depend on
 * human attention. Rejections (refunds) are worked before approvals.
 */
export async function sweepUnexecutedApprovals(now: Date = new Date()): Promise<{ swept: number; recovered: number }> {
  const due = await db
    .select()
    .from(operatorApprovalsTable)
    .where(and(
      eq(operatorApprovalsTable.executed, false),
      inArray(operatorApprovalsTable.status, ["approved", "rejected"]),
      // null (never attempted) OR due (backoff elapsed / lease expired).
      or(isNull(operatorApprovalsTable.nextExecuteAt), lte(operatorApprovalsTable.nextExecuteAt, now)),
    ))
    .limit(50);
  // Rejections (refunds owed) before approvals — money out first.
  due.sort((a, b) => (a.status === b.status ? 0 : a.status === "rejected" ? -1 : 1));

  let recovered = 0;
  for (const row of due) {
    const claimed = await claimForExecution(row.id, now);
    if (!claimed) continue; // another runner won the claim
    const out = await runHandler(claimed);
    if (out.executed) recovered++;
  }
  return { swept: due.length, recovered };
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startApprovalExecutionSweeper(): void {
  if (sweepTimer) return;
  // Fail loud at boot if a money kind lost its handler (missed import /
  // load-order) — better a crash than silently marking refunds "done".
  assertRequiredHandlers();
  sweepTimer = setInterval(() => {
    sweepUnexecutedApprovals().catch((e) => logger.warn({ err: e }, "approval execution sweep failed"));
  }, 60_000);
  sweepTimer.unref();
  logger.info("operator-approval execution sweeper armed (60s)");
}
