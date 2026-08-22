/**
 * operator-approvals-core.ts — the pure half of the operator approval inbox.
 *
 * The handler registry and decision validation, with no I/O, so a new kind's
 * wiring can be unit-tested without a database. The db-backed operations
 * (requestApproval / listApprovals / decideApproval) live in
 * operator-approvals.ts and consult this registry.
 */

export type ApprovalDecision = "approved" | "rejected";

export interface ApprovalRow {
  id: number;
  kind: string;
  status: string;
  title: string;
  body: string | null;
  payload: unknown;
  requestedBy: string | null;
}

export interface ApprovalHandler {
  /** Run when the operator approves. Its own errors do NOT un-decide the
   *  approval — the decision stands, the execution is reported and retryable. */
  onApprove?: (approval: ApprovalRow) => Promise<void>;
  /** Run when the operator rejects — e.g. refund a paid-but-rejected ad. */
  onReject?: (approval: ApprovalRow) => Promise<void>;
}

const handlers = new Map<string, ApprovalHandler>();

/**
 * Kinds whose decision MOVES MONEY or airs public content, so a missing
 * handler must never be treated as "nothing to do" (that would record a
 * refund/go-live that never happened). For these, runHandler keeps the row
 * unexecuted and retrying until a handler is present, and `assertRequiredHandlers`
 * fails boot loudly if one is missing. `radio_ad` joins this set when its
 * handler ships.
 */
const HANDLER_REQUIRED_KINDS = new Set<string>([]);

export function isHandlerRequiredKind(kind: string): boolean {
  return HANDLER_REQUIRED_KINDS.has(kind);
}

/** Throw at boot if any money kind lacks a handler — fail loud, not silent. */
export function assertRequiredHandlers(): void {
  const missing = [...HANDLER_REQUIRED_KINDS].filter((k) => !handlers.has(k));
  if (missing.length) {
    throw new Error(`operator-approvals: money kinds missing a handler at boot: ${missing.join(", ")}`);
  }
}

/**
 * Register the handler for a kind. Called once at module load by each feature
 * that raises approvals (tower tenancy, radio ads, …). A kind with no handler
 * is still a valid inbox item — approving it just records the decision and
 * does nothing else, which is the honest behavior for an informational one.
 */
export function registerApprovalHandler(kind: string, handler: ApprovalHandler): void {
  handlers.set(kind, handler);
}

export function getApprovalHandler(kind: string): ApprovalHandler | undefined {
  return handlers.get(kind);
}

/** Test seam. */
export function _clearApprovalHandlers(): void {
  handlers.clear();
}

export function isValidDecision(d: unknown): d is ApprovalDecision {
  return d === "approved" || d === "rejected";
}
