import { recordEventCursor } from "./partnerClient";

/**
 * The one owner of a replay's per-type cursor advances (#418).
 *
 * The replay cursor has one non-negotiable invariant: once an event of a type
 * has DEFERRED (its precondition is not yet met — #103), the persisted cursor
 * must not advance past it, on ANY path, or the deferred event is never
 * re-offered and is silently lost. That invariant was first enforced with a
 * `deferred` flag and three site-local guards in the startup loop — and the
 * review of that fix found the predictable holes: a fourth persist site in a
 * sibling admin loop forgot the guard entirely, the end-of-page advance and
 * the skip-the-failed-event path each needed their own guard, and a type whose
 * FIRST event deferred was never pinned onto its own cursor, so next boot it
 * fell back to the shared, mutable `lastEventUuid` that other types advance —
 * the same skip one level down.
 *
 * So the invariant lives in ONE object that owns every advance. A loop drives
 * dispatch and calls onProcessed / onDeferred / onFailed / onPageBoundary; the
 * cursor decides what is persisted. A new persist site cannot be added without
 * going through it.
 *
 * Two positions, deliberately distinct:
 *  - the FETCH position keeps advancing even while held, so later pages are
 *    still fetched and their (possibly applicable) events still dispatched;
 *  - the PERSISTED position freezes at the deferral, so the next replay
 *    re-offers the held event.
 */
export class ReplayCursor {
  private fetch: string | null;
  private persisted: string | null;
  private deferred = false;
  private pinned = false;
  private consecutiveFailures = 0;

  constructor(seed: string | null, private readonly eventType?: string) {
    this.fetch = seed;
    this.persisted = seed;
  }

  /** Where the next page fetch should start. Advances even while held. */
  fetchFrom(): string | null {
    return this.fetch;
  }

  get held(): boolean {
    return this.deferred;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  /** Last position reasoned about — for the boot summary, not for seeding. */
  position(): string | null {
    return this.fetch;
  }

  /**
   * A dispatched event deferred. Freeze persistence, and PIN the type onto its
   * own cursor: persist the held (pre-deferral) position into
   * eventCursors[type] once, so a type whose first event defers no longer
   * seeds from the shared legacy `lastEventUuid` next boot. When there is no
   * prior position to pin to (seed was null — a brand-new type on a fresh DB),
   * the fetch already starts from the top, which re-offers the event on its
   * own unless a concurrent type has advanced the legacy fallback; that narrow
   * first-run case is the one gap and is logged by the caller.
   */
  async onDeferred(): Promise<void> {
    this.consecutiveFailures = 0;
    if (this.deferred) return;
    this.deferred = true;
    if (!this.pinned && this.persisted != null) {
      this.pinned = true;
      await recordEventCursor(this.persisted, this.eventType);
    }
  }

  /** A dispatched event was applied or ignored. Advance both positions unless
   *  held. Persistence errors propagate to the caller's OUTER handler, never
   *  the per-event catch — a DB blip on the cursor write is not a handler
   *  failure and must not inflate the failure counter. */
  async onProcessed(uuid: string): Promise<void> {
    this.consecutiveFailures = 0;
    if (this.deferred) return;
    this.fetch = uuid;
    this.persisted = uuid;
    await recordEventCursor(uuid, this.eventType);
  }

  /** A dispatch threw. Skip the event — but never advance past a held
   *  deferral. Returns the running consecutive-failure count (hoisted here so
   *  it survives page boundaries and can actually trip the circuit breaker). */
  async onFailed(uuid: string): Promise<number> {
    this.consecutiveFailures++;
    if (!this.deferred) {
      this.fetch = uuid;
      this.persisted = uuid;
      await recordEventCursor(uuid, this.eventType).catch(() => {});
    }
    return this.consecutiveFailures;
  }

  /** End of a page. Keep fetching from next_cursor, but persist the advance
   *  only when not held. */
  async onPageBoundary(nextCursor: string): Promise<void> {
    this.fetch = nextCursor;
    if (!this.deferred) {
      this.persisted = nextCursor;
      await recordEventCursor(nextCursor, this.eventType);
    }
  }
}
