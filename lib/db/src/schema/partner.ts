import { pgTable, text, timestamp, integer, varchar } from "drizzle-orm/pg-core";

export const processedEventsTable = pgTable("processed_events", {
  eventUuid: varchar("event_uuid", { length: 64 }).primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
});

export const partnerSyncStateTable = pgTable("partner_sync_state", {
  id: text("id").primaryKey(),
  lastArtifactCursor: text("last_artifact_cursor"),
  lastEventUuid: text("last_event_uuid"),
  lastPollAt: timestamp("last_poll_at"),
  lastWebhookAt: timestamp("last_webhook_at"),
  webhookSubscribed: text("webhook_subscribed").notNull().default("unknown"),
  requestsToday: integer("requests_today").notNull().default(0),
  requestsDayKey: text("requests_day_key"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ProcessedEvent = typeof processedEventsTable.$inferSelect;
export type PartnerSyncState = typeof partnerSyncStateTable.$inferSelect;
