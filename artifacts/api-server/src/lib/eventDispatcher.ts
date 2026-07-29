import type { Logger } from "pino";
import { db } from "@workspace/db";
import { processedEventsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger as rootLogger } from "./logger";

export interface EventContext {
  log: Logger;
  source: "webhook" | "replay";
}

export type EventHandler = (data: unknown, ctx: EventContext) => Promise<void>;

/**
 * Thrown by a handler that cannot apply an event YET, but might later.
 *
 * The distinction matters because of what the dispatcher does next. A handler
 * that returns normally is recorded in `processed_events`, and that record is
 * permanent — so a handler which quietly gave up (say, a reaction whose
 * artifact has not been ingested) burned the event's only chance. Replay could
 * not recover it, because replay dedupes on exactly that table. (#103)
 *
 * Throwing this instead leaves the event unrecorded, so a later replay
 * re-delivers it once the precondition is satisfied. It is deliberately NOT a
 * generic error: a real failure should still surface as one.
 */
export class EventDeferredError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`event deferred: ${reason}`);
    this.name = "EventDeferredError";
    this.reason = reason;
  }
}

const handlers = new Map<string, EventHandler>();

export function registerEventHandler(eventType: string, handler: EventHandler): void {
  handlers.set(eventType, handler);
}

export function getRegisteredEventTypes(): string[] {
  return Array.from(handlers.keys());
}

export interface DispatchResult {
  status: "handled" | "deduped" | "unhandled" | "deferred";
  /** Present only on "deferred": why the handler could not apply it yet. */
  reason?: string;
  eventType: string;
  eventUuid: string;
}

/**
 * Generic webhook/replay dispatcher. Looks up the handler by event type, runs
 * it, and records the event as processed. Dedupe is enforced via the
 * processed_events unique constraint and a pre-check.
 */
export async function dispatchPartnerEvent(args: {
  eventType: string;
  eventUuid: string;
  data: unknown;
  log?: Logger;
  source: "webhook" | "replay";
}): Promise<DispatchResult> {
  const log = args.log ?? rootLogger;

  const already = await db
    .select({ eventUuid: processedEventsTable.eventUuid })
    .from(processedEventsTable)
    .where(eq(processedEventsTable.eventUuid, args.eventUuid))
    .limit(1);
  if (already.length > 0) {
    return { status: "deduped", eventType: args.eventType, eventUuid: args.eventUuid };
  }

  const handler = handlers.get(args.eventType);
  if (!handler) {
    log.info({ eventType: args.eventType, eventUuid: args.eventUuid }, "No handler registered for event type");
    await db
      .insert(processedEventsTable)
      .values({ eventUuid: args.eventUuid, eventType: args.eventType })
      .onConflictDoNothing();
    return { status: "unhandled", eventType: args.eventType, eventUuid: args.eventUuid };
  }

  try {
    await handler(args.data, { log, source: args.source });
  } catch (err) {
    if (err instanceof EventDeferredError) {
      // Deliberately NOT recorded as processed — that is the whole point.
      // Leaving it absent from processed_events is what lets a later replay
      // deliver it again once the precondition holds. (#103)
      log.info(
        { eventType: args.eventType, eventUuid: args.eventUuid, reason: err.reason },
        "event deferred — left unprocessed so replay can retry it",
      );
      return {
        status: "deferred",
        reason: err.reason,
        eventType: args.eventType,
        eventUuid: args.eventUuid,
      };
    }
    throw err;
  }
  await db
    .insert(processedEventsTable)
    .values({ eventUuid: args.eventUuid, eventType: args.eventType })
    .onConflictDoNothing();
  return { status: "handled", eventType: args.eventType, eventUuid: args.eventUuid };
}
