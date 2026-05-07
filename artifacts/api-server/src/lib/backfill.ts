import { db } from "@workspace/db";
import { usersTable, artifactsTable, dropsTable } from "@workspace/db/schema";
import { isNull } from "drizzle-orm";
import { logger } from "./logger";

export const KANNAKA_SYSTEM_USER_ID = "kannaka-system";

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

  const artifactBackfill = await db
    .update(artifactsTable)
    .set({ ownerId: KANNAKA_SYSTEM_USER_ID })
    .where(isNull(artifactsTable.ownerId))
    .returning({ id: artifactsTable.id });

  const dropBackfill = await db
    .update(dropsTable)
    .set({ ownerId: KANNAKA_SYSTEM_USER_ID })
    .where(isNull(dropsTable.ownerId))
    .returning({ id: dropsTable.id });

  if (artifactBackfill.length > 0 || dropBackfill.length > 0) {
    logger.info(
      { artifacts: artifactBackfill.length, drops: dropBackfill.length },
      "Backfilled ownerId on legacy rows to Kannaka system user",
    );
  }
}
