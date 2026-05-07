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

const handlers = new Map<string, EventHandler>();

export function registerEventHandler(eventType: string, handler: EventHandler): void {
  handlers.set(eventType, handler);
}

export function getRegisteredEventTypes(): string[] {
  return Array.from(handlers.keys());
}

export interface DispatchResult {
  status: "handled" | "deduped" | "unhandled";
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

  await handler(args.data, { log, source: args.source });
  await db
    .insert(processedEventsTable)
    .values({ eventUuid: args.eventUuid, eventType: args.eventType })
    .onConflictDoNothing();
  return { status: "handled", eventType: args.eventType, eventUuid: args.eventUuid };
}
