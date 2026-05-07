import { db } from "@workspace/db";
import { usersTable, artifactsTable, dropsTable, agentsTable } from "@workspace/db/schema";
import { isNull, eq, and } from "drizzle-orm";
import { logger } from "./logger";

export const KANNAKA_SYSTEM_USER_ID = "kannaka-system";
export const KANNAKA_AGENT_SLUG = "kannaka";

export async function ensureKannakaOwnerAndBackfill(): Promise<void> {
  await db
    .insert(usersTable)
    .values({
      id: KANNAKA_SYSTEM_USER_ID,
      email: "kannaka@kax.local",
      firstName: "Kannaka",
      lastName: null,
      displayName: "Kannaka",
      role: "admin",
    })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: { role: "admin", displayName: "Kannaka", updatedAt: new Date() },
    });

  // Ensure the kannaka agent exists, owned by the Kannaka system user.
  await db
    .insert(agentsTable)
    .values({
      slug: KANNAKA_AGENT_SLUG,
      displayName: "Kannaka",
      ownerId: KANNAKA_SYSTEM_USER_ID,
    })
    .onConflictDoNothing({ target: agentsTable.slug });

  const [kannakaAgent] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(eq(agentsTable.slug, KANNAKA_AGENT_SLUG))
    .limit(1);

  const artifactBackfill = await db
    .update(artifactsTable)
    .set({ ownerId: KANNAKA_SYSTEM_USER_ID })
    .where(isNull(artifactsTable.ownerId))
    .returning({ id: artifactsTable.id });

  // Only tag legacy artifacts that actually belong to the Kannaka system user.
  // Other users' historical rows must not be auto-attributed to the Kannaka agent.
  let agentBackfill: { id: number }[] = [];
  if (kannakaAgent) {
    agentBackfill = await db
      .update(artifactsTable)
      .set({ agentId: kannakaAgent.id })
      .where(
        and(
          isNull(artifactsTable.agentId),
          eq(artifactsTable.ownerId, KANNAKA_SYSTEM_USER_ID),
        ),
      )
      .returning({ id: artifactsTable.id });
  }

  const dropBackfill = await db
    .update(dropsTable)
    .set({ ownerId: KANNAKA_SYSTEM_USER_ID })
    .where(isNull(dropsTable.ownerId))
    .returning({ id: dropsTable.id });

  if (artifactBackfill.length > 0 || dropBackfill.length > 0 || agentBackfill.length > 0) {
    logger.info(
      {
        artifacts: artifactBackfill.length,
        drops: dropBackfill.length,
        agentTagged: agentBackfill.length,
      },
      "Backfilled ownerId/agentId on legacy rows",
    );
  }
}
