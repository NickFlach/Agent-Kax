import { pgTable, text, timestamp, integer, varchar, jsonb } from "drizzle-orm/pg-core";

export const processedEventsTable = pgTable("processed_events", {
  eventUuid: varchar("event_uuid", { length: 64 }).primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
});

export const partnerSyncStateTable = pgTable("partner_sync_state", {
  id: text("id").primaryKey(),
  lastArtifactCursor: text("last_artifact_cursor"),
  /**
   * Most recently processed event overall. Retained for display only
   * (`/admin`, `/dashboard`) — replay position now lives in `eventCursors`.
   */
  lastEventUuid: text("last_event_uuid"),
  /**
   * Replay position per event type: `{ "dm.received": "<uuid>", ... }`.
   *
   * Startup replay used the single `lastEventUuid` across every event type.
   * Because it is advanced and persisted per event, by the time the loop
   * reached the second type the cursor already sat at wherever the first
   * type's stream ended — so backlog for later types was skipped, and
   * persisted as skipped. (#67)
   */
  eventCursors: jsonb("event_cursors").$type<Record<string, string>>(),
  lastPollAt: timestamp("last_poll_at"),
  lastWebhookAt: timestamp("last_webhook_at"),
  webhookSubscribed: text("webhook_subscribed").notNull().default("unknown"),
  requestsToday: integer("requests_today").notNull().default(0),
  requestsDayKey: text("requests_day_key"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ProcessedEvent = typeof processedEventsTable.$inferSelect;
export type PartnerSyncState = typeof partnerSyncStateTable.$inferSelect;
