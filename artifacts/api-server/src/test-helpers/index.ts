import { randomUUID } from "node:crypto";
import pino, { type Logger } from "pino";
import { db } from "@workspace/db";
import {
  agentsTable,
  usersTable,
  proposalsTable,
  dmsTable,
  matchesTable,
  activitiesTable,
} from "@workspace/db/schema";
import { inArray, like, or } from "drizzle-orm";

const TEST_PREFIX = "kax-test-";

export const testLogger: Logger = pino({ level: "silent" });

export function makeTestId(label = ""): string {
  return `${TEST_PREFIX}${label}${label ? "-" : ""}${randomUUID()}`;
}

/**
 * Returns a unique, prefix-tagged identifier suitable for use as a
 * `source_uuid` in test rows. The `kax-test-` prefix matches the LIKE filter
 * used by `cleanupTestData()` so even unrouted rows (ownerId=null) are removed
 * between runs and don't accumulate in the dev DB.
 */
export function makeUuid(): string {
  return `${TEST_PREFIX}uuid-${randomUUID()}`;
}

export async function createTestUser(opts: {
  role?: "user" | "admin";
  emailLabel?: string;
} = {}): Promise<{ id: string; email: string; role: "user" | "admin" }> {
  const id = makeTestId(`user-${opts.role ?? "user"}`);
  const email = `${id}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      id,
      email,
      role: opts.role ?? "user",
      firstName: "Test",
      lastName: "User",
    })
    .returning();
  return { id: row.id, email: row.email!, role: row.role };
}

export async function createTestAgent(ownerId: string, label = "agent"): Promise<{
  id: number;
  slug: string;
  ownerId: string;
}> {
  const slug = makeTestId(label);
  const [row] = await db
    .insert(agentsTable)
    .values({
      slug,
      displayName: `Test Agent ${label}`,
      ownerId,
    })
    .returning();
  return { id: row.id, slug: row.slug, ownerId: row.ownerId };
}

/**
 * Remove every row created by these helpers. Safe to call between tests; only
 * touches rows whose id/slug/uuid begins with the test prefix.
 */
export async function cleanupTestData(): Promise<void> {
  // proposals/dms/matches: source_uuid is a random UUID. We track them via the
  // owners we made, so deleting by ownerId or by source_uuid LIKE prefix works.
  // We delete any row whose ownerId starts with the test prefix, plus any
  // unrouted (ownerId NULL) row whose source_uuid we tagged with the prefix.
  const ownerLike = `${TEST_PREFIX}%`;
  const uuidLike = `${TEST_PREFIX}%`;

  await db
    .delete(proposalsTable)
    .where(or(like(proposalsTable.ownerId, ownerLike), like(proposalsTable.sourceUuid, uuidLike)));
  await db
    .delete(dmsTable)
    .where(or(like(dmsTable.ownerId, ownerLike), like(dmsTable.sourceUuid, uuidLike)));
  await db
    .delete(matchesTable)
    .where(or(like(matchesTable.ownerId, ownerLike), like(matchesTable.sourceUuid, uuidLike)));
  await db.delete(activitiesTable).where(like(activitiesTable.ownerId, ownerLike));
  await db.delete(agentsTable).where(like(agentsTable.slug, ownerLike));
  await db.delete(usersTable).where(like(usersTable.id, ownerLike));
}

export async function deleteUsersByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}
