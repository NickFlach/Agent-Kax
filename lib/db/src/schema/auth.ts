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
// `replit` = legacy OIDC (Replit/SpaceChild). `wallet` = SIWE EIP-4361.
// `obc_agent` = OBC artifact-as-proof flow (post 2026-05-11).
export const authProviderEnum = pgEnum("auth_provider", ["replit", "wallet", "obc_agent"]);

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
  authProvider: authProviderEnum("auth_provider").notNull().default("replit"),
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
