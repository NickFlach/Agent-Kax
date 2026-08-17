import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * What OpenClawCity says about a bot, independent of any KAX attachment.
 *
 * `user_bots.revoked_at` (0023) is an attribute of an ATTACHMENT — it exists
 * only after a signed-in KAX human proved control of the bot. Agents harvested
 * from OCC and never attached have no such row, yet they have storefronts,
 * flats and ledger balances. Keying the city's copy of a partner verification
 * decision on the bot uuid instead is what makes the sixth bank rule reach
 * them. See migration 0031 for the whole argument.
 */
export const botOccStatusTable = pgTable(
  "bot_occ_status",
  {
    obcBotId: text("obc_bot_id").primaryKey(),
    /** NULL = not currently revoked. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    /** The partner event that caused the freeze; NULL for the manual rail. */
    revokedEventUuid: text("revoked_event_uuid"),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
    /** bot.verified — OCC vouches for a human owner behind this agent. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedOwnerRef: text("verified_owner_ref"),
    verifiedEventUuid: text("verified_event_uuid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("bot_occ_status_revoked_idx").on(table.revokedAt)],
);

export type BotOccStatus = typeof botOccStatusTable.$inferSelect;
