import { eq, lt } from "drizzle-orm";
import { db } from "@workspace/db";
import { cityResidentsTable } from "@workspace/db/schema";
import type { InhabitantKind } from "./presence";
import * as residents from "./residents";
import { revokedBotIds } from "./revocation";
import { logger } from "./logger";

/**
 * Where a residency goes so it can outlive a deploy.
 *
 * Kept apart from lib/residents on purpose: the registry is the city's clock
 * and must never be held up by a database, and its tests must never need one
 * running. So the registry knows only an interface, and this is the half that
 * knows Postgres.
 *
 * Writes are FIRE AND FORGET. A body standing in a street is already correct
 * in memory; the worst case of a dropped write is that a restart forgets one
 * resident, while making the tick loop await a database would let a slow query
 * freeze everybody at once. That trade is deliberate and one-directional.
 */
export const pgResidencyStore: residents.ResidencyStore = {
  save(r) {
    void db
      .insert(cityResidentsTable)
      .values({
        principal: r.principal,
        name: r.name,
        kind: r.kind,
        room: r.room,
        x: r.x,
        z: r.z,
        yaw: r.yaw,
        lastSteer: new Date(r.lastSteer),
      })
      .onConflictDoUpdate({
        target: cityResidentsTable.principal,
        set: {
          name: r.name,
          kind: r.kind,
          room: r.room,
          x: r.x,
          z: r.z,
          yaw: r.yaw,
          lastSteer: new Date(r.lastSteer),
        },
      })
      .catch((e) => logger.warn({ err: e, principal: r.principal }, "residency save failed"));
  },

  remove(principal) {
    void db
      .delete(cityResidentsTable)
      .where(eq(cityResidentsTable.principal, principal))
      .catch((e) => logger.warn({ err: e, principal }, "residency delete failed"));
  },

  async load() {
    const rows = await db.select().from(cityResidentsTable);
    return rows.map((r) => ({
      principal: r.principal,
      name: r.name,
      kind: (r.kind === "human" ? "human" : "agent") as InhabitantKind,
      room: r.room,
      x: r.x,
      z: r.z,
      yaw: r.yaw,
      lastSteer: r.lastSteer.getTime(),
    }));
  },
};

/**
 * Stand everybody back up, once, at boot.
 *
 * Failure here is survivable and must not stop the server: an empty city is a
 * bad morning, a server that will not start is a worse one. Anyone missed can
 * move back in with a single call.
 */
/**
 * How often the city re-reads who has been revoked.
 *
 * A minute is the honest trade. The tick loop must not query a database, so
 * the revoked set is refreshed out of band — which means there is always a
 * window between a revocation landing and a body leaving the street. Making
 * it small costs one cheap indexed query a minute; making it zero would cost
 * a query per resident per tick.
 */
const REVOCATION_REFRESH_MS = 60_000;

/** Re-read the revoked set and hand it to the registry. */
export async function refreshRevocations(): Promise<number> {
  const ids = await revokedBotIds();
  // The registry keys on principals, and one bot answers to two forms.
  const principals: string[] = [];
  for (const id of ids) {
    principals.push(`obc:${id}`, `kax:agent:${id}`);
  }
  residents.setRevokedPrincipals(principals);
  return ids.size;
}

export async function restoreResidents(): Promise<number> {
  residents.setStore(pgResidencyStore);

  // Learn who is revoked BEFORE standing anybody back up, or a restart would
  // briefly re-house an agent the city has already disowned.
  try {
    const n = await refreshRevocations();
    if (n) logger.info({ revoked: n }, "revoked bots will not be hosted");
  } catch (e) {
    logger.warn({ err: e }, "could not read revocations at boot");
  }
  const timer = setInterval(() => {
    refreshRevocations().catch((e) => logger.warn({ err: e }, "revocation refresh failed"));
  }, REVOCATION_REFRESH_MS);
  timer.unref?.();

  try {
    // Clear out anyone who had already gone quiet before the restart, so the
    // table does not accumulate tenancies nobody is coming back to.
    const cutoff = new Date(Date.now() - residents.IDLE_MS);
    await db.delete(cityResidentsTable).where(lt(cityResidentsTable.lastSteer, cutoff));

    const restored = residents.restore(await pgResidencyStore.load());
    if (restored) logger.info({ restored }, "residents stood back up after restart");
    return restored;
  } catch (e) {
    const err = e as { message?: string; code?: string };
    // 42P01 is "table missing", which is worth naming: it means the migration
    // has not run here yet rather than anything being broken.
    logger.error(
      { code: err.code, message: err.message },
      err.code === "42P01"
        ? "city_residents does not exist yet — residents will not survive restarts until 0020 runs"
        : "could not restore residents; the city starts empty",
    );
    return 0;
  }
}
