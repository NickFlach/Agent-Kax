import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);

// Auth provider — which credential issued this user's identity.
// `wallet` = SIWE EIP-4361 (canonical, post task #24). `obc_agent` =
// OBC artifact-as-proof flow, retained for grandfathered rows whose
// session was minted before the wallet-primary refactor (task #21).
// The legacy `replit` OIDC variant was dropped in migration 0003.
export const authProviderEnum = pgEnum("auth_provider", ["wallet", "obc_agent"]);

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
// Extended 2026-05-11 with walletAddress + obcBotId for the new auth
// paths. Both nullable + unique so a row is reachable by any one of
// {id, email, walletAddress, obcBotId}.
export const usersTable = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  displayName: varchar("display_name"),
  bio: text("bio"),
  role: userRoleEnum("role").notNull().default("user"),
  emailOnProposal: boolean("email_on_proposal").notNull().default(false),
  emailOnDm: boolean("email_on_dm").notNull().default(false),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  // New auth identities (2026-05-11): either is enough to identify the
  // user without OIDC. Lowercase 0x+40 hex for wallet; OBC bot UUID for
  // obcBotId.
  walletAddress: varchar("wallet_address").unique(),
  obcBotId: varchar("obc_bot_id").unique(),
  authProvider: authProviderEnum("auth_provider").notNull().default("wallet"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type UpsertUser = typeof usersTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;

// Short-lived challenges for the two new auth flows.
//   - wallet_nonce: SIWE nonce; user signs an EIP-4361 message
//     containing this nonce with their wallet, server recovers the
//     address from the signature, matches against claimSubject.
//   - agent_challenge: a short phrase like "KAX-VERIFY-abc123"; user
//     creates an OBC artifact whose description includes the phrase,
//     server fetches the artifact via the partner API and confirms
//     the creator_bot_id matches claimSubject + the phrase appears.
export const authChallengeKindEnum = pgEnum("auth_challenge_kind", ["wallet_nonce", "agent_challenge"]);

export const authChallengesTable = pgTable(
  "auth_challenges",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    kind: authChallengeKindEnum("kind").notNull(),
    challenge: text("challenge").notNull(),
    // Server-side canonical payload for the challenge. For wallet_nonce
    // this is the full SIWE message text the server issued; /verify
    // must verify the signature against THIS bytes (not against any
    // client-supplied message). Nullable for backward-compat with
    // pre-2026-05-11 rows.
    payload: text("payload"),
    claimSubject: varchar("claim_subject").notNull(),
    consumed: boolean("consumed").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_auth_challenges_kind_subject").on(table.kind, table.claimSubject),
    index("idx_auth_challenges_expires").on(table.expiresAt),
  ],
);

export type AuthChallenge = typeof authChallengesTable.$inferSelect;

// user_bots — join table mapping a wallet user to one or more OBC bots
// they've proven ownership of via the agent-verify flow. One bot can
// only be attached to one wallet (UNIQUE on obcBotId). A wallet can
// attach many bots.
//
// (`users.obcBotId` is preserved for now to grandfather any legacy
// `obc_agent`-keyed sessions issued before this refactor; it is not
// used for new attachments. Cleanup happens in the OIDC strip task.)
export const userBotsTable = pgTable(
  "user_bots",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    obcBotId: varchar("obc_bot_id").notNull().unique(),
    displayName: varchar("display_name"),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_user_bots_user").on(table.userId)],
);

export type UserBot = typeof userBotsTable.$inferSelect;
export type InsertUserBot = typeof userBotsTable.$inferInsert;
