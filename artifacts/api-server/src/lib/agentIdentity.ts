import { and, eq, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  activitiesTable,
  agentStorefrontSettingsTable,
  agentsTable,
  artifactsTable,
  dmsTable,
  matchesTable,
  outboundMessagesTable,
  proposalsTable,
  residenceUnitsTable,
  storeListingsTable,
} from "@workspace/db/schema";
import { logger } from "./logger";

/**
 * When one agent exists twice.
 *
 * Kannaka has two rows. Agent 1 holds the slug `kannaka` — the public
 * storefront URL, the constant KANNAKA_AGENT_SLUG, the redirect target from
 * /storefront — and has no obc_bot_id and zero works. Agent 62 holds the bot
 * uuid, 1909 artifacts including her furniture, and the penthouse. Everything
 * that identifies her by NAME finds the empty row; everything that identifies
 * her by BOT finds the full one.
 *
 * The mechanism is in findOrCreateAgentByBotUuid: it slugifies the display
 * name, finds `kannaka` already taken by a row that predates bot ids, and
 * falls back to `kannaka-<first 6 of uuid>`. That fallback is correct — two
 * different bots with one name must not collapse into each other — but it
 * cannot tell a genuine namesake from the same agent arriving under a slug it
 * already owns, because the older row has no bot id to compare against.
 *
 * The visible damage is quiet in every direction: her storefront shows none of
 * her work, joinery_works returns nothing so she cannot sell anything, and the
 * city's own answer to "who is Kannaka" depends on which door you came in by.
 * Nothing errors. This is the same shape as the clawdine 41 / unknown-<uuid>
 * 900+ split repairUnknownAgents already fixes, mirrored: there the NAMED row
 * was the good one, here it is the BOT-BEARING row.
 *
 * DRY RUN IS THE DEFAULT EVERYWHERE IT CAN BE. Merging identities moves rows
 * across nine foreign keys and deletes an agent; two of those keys are unique,
 * so a merge can be refused by the database halfway through. The plan is
 * computed and reported first, conflicts included, and only then applied.
 */

/** A pair of rows that look like one agent split in two. */
export interface SplitIdentity {
  displayName: string;
  /** The row holding the bot uuid and, usually, the work. This one survives. */
  keep: { id: number; slug: string; obcBotId: string; works: number };
  /** The row holding only a name and a slug. Merged away. */
  drop: { id: number; slug: string; works: number };
  /** Whether the canonical slug moves from the dropped row to the kept one. */
  slugTransfer: boolean;
  /** Anything that would make the merge fail or lose data, in plain words. */
  conflicts: string[];
}

async function worksOf(agentId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(artifactsTable)
    .where(eq(artifactsTable.agentId, agentId));
  return row?.n ?? 0;
}

async function hasRow(table: typeof residenceUnitsTable | typeof agentStorefrontSettingsTable, agentId: number) {
  const col = table === residenceUnitsTable ? residenceUnitsTable.agentId : agentStorefrontSettingsTable.agentId;
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(col, agentId));
  return (row?.n ?? 0) > 0;
}

/**
 * Find agents that are one identity wearing two rows.
 *
 * The signature is narrow on purpose: same display name, one row WITH a bot
 * uuid and one WITHOUT. Two rows that both carry bot uuids are genuine
 * namesakes and must never be merged — that would hand one agent another's
 * work, which is worse than the split it fixes.
 */
export async function findSplitIdentities(): Promise<SplitIdentity[]> {
  const botless = await db
    .select({ id: agentsTable.id, slug: agentsTable.slug, displayName: agentsTable.displayName })
    .from(agentsTable)
    .where(isNull(agentsTable.obcBotId));

  const out: SplitIdentity[] = [];
  for (const row of botless) {
    const [twin] = await db
      .select({ id: agentsTable.id, slug: agentsTable.slug, obcBotId: agentsTable.obcBotId })
      .from(agentsTable)
      .where(
        and(
          sql`lower(${agentsTable.displayName}) = ${row.displayName.trim().toLowerCase()}`,
          isNotNull(agentsTable.obcBotId),
          ne(agentsTable.id, row.id),
        ),
      )
      .limit(2);
    if (!twin) continue;

    // More than one bot-bearing twin means the name is ambiguous and a human
    // has to say which is which. Reported, never guessed at.
    const [, second] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(
        and(
          sql`lower(${agentsTable.displayName}) = ${row.displayName.trim().toLowerCase()}`,
          isNotNull(agentsTable.obcBotId),
        ),
      )
      .limit(2);

    const conflicts: string[] = [];
    if (second) conflicts.push("more than one bot-bearing agent shares this name — resolve by hand");
    if (await hasRow(residenceUnitsTable, row.id)) {
      if (await hasRow(residenceUnitsTable, twin.id)) {
        conflicts.push("both rows hold a home, and one agent may only hold one");
      }
    }
    if ((await hasRow(agentStorefrontSettingsTable, row.id)) && (await hasRow(agentStorefrontSettingsTable, twin.id))) {
      conflicts.push("both rows have storefront settings — the dropped row's would be discarded");
    }

    out.push({
      displayName: row.displayName,
      keep: { id: twin.id, slug: twin.slug, obcBotId: twin.obcBotId!, works: await worksOf(twin.id) },
      drop: { id: row.id, slug: row.slug, works: await worksOf(row.id) },
      // The botless row usually holds the nicer slug — it got there first.
      slugTransfer: row.slug.length < twin.slug.length,
      conflicts,
    });
  }
  return out;
}

export interface MergeResult {
  dryRun: boolean;
  merged: number;
  skipped: number;
  details: Array<{
    displayName: string;
    keptSlug: string;
    droppedSlug: string;
    moved: Record<string, number>;
    action: "merged" | "skipped";
    reason?: string;
  }>;
}

/**
 * Merge every split identity, or report what merging would do.
 *
 * The surviving row is always the one holding the bot uuid, because that is
 * the row the harvester will keep writing to — merging the other way would fix
 * the storefront today and re-split it on the next ingest.
 *
 * Idempotent: once merged there is no botless twin left to find, so a second
 * run reports nothing to do rather than doing it again.
 */
export async function mergeSplitIdentities(opts: { dryRun?: boolean } = {}): Promise<MergeResult> {
  const dryRun = opts.dryRun !== false;
  const splits = await findSplitIdentities();
  const result: MergeResult = { dryRun, merged: 0, skipped: 0, details: [] };

  for (const s of splits) {
    if (s.conflicts.length) {
      result.skipped++;
      result.details.push({
        displayName: s.displayName,
        keptSlug: s.keep.slug,
        droppedSlug: s.drop.slug,
        moved: {},
        action: "skipped",
        reason: s.conflicts.join("; "),
      });
      continue;
    }

    // Everything that points at an agent. A key missed here does not error —
    // it silently leaves a row pointing at an agent that no longer exists, or
    // blocks the delete with a constraint. Both are worse than the split.
    const movers: Array<[string, () => Promise<number>]> = [
      ["artifacts", async () =>
        (await db.update(artifactsTable).set({ agentId: s.keep.id }).where(eq(artifactsTable.agentId, s.drop.id)).returning({ id: artifactsTable.id })).length],
      ["store_listings", async () =>
        (await db.update(storeListingsTable).set({ storeAgentId: s.keep.id }).where(eq(storeListingsTable.storeAgentId, s.drop.id)).returning({ id: storeListingsTable.id })).length],
      ["activities", async () =>
        (await db.update(activitiesTable).set({ agentId: s.keep.id }).where(eq(activitiesTable.agentId, s.drop.id)).returning({ id: activitiesTable.id })).length],
      ["proposals", async () =>
        (await db.update(proposalsTable).set({ agentId: s.keep.id }).where(eq(proposalsTable.agentId, s.drop.id)).returning({ id: proposalsTable.id })).length],
      ["dms", async () =>
        (await db.update(dmsTable).set({ agentId: s.keep.id }).where(eq(dmsTable.agentId, s.drop.id)).returning({ id: dmsTable.id })).length],
      ["matches", async () =>
        (await db.update(matchesTable).set({ agentId: s.keep.id }).where(eq(matchesTable.agentId, s.drop.id)).returning({ id: matchesTable.id })).length],
      ["outbound_messages", async () =>
        (await db.update(outboundMessagesTable).set({ agentId: s.keep.id }).where(eq(outboundMessagesTable.agentId, s.drop.id)).returning({ id: outboundMessagesTable.id })).length],
      ["residence_units", async () =>
        (await db.update(residenceUnitsTable).set({ agentId: s.keep.id }).where(eq(residenceUnitsTable.agentId, s.drop.id)).returning({ id: residenceUnitsTable.id })).length],
      ["agent_storefront_settings", async () =>
        (await db.update(agentStorefrontSettingsTable).set({ agentId: s.keep.id }).where(eq(agentStorefrontSettingsTable.agentId, s.drop.id)).returning({ agentId: agentStorefrontSettingsTable.agentId })).length],
    ];

    if (dryRun) {
      // Count without moving, so the report is real rather than optimistic.
      const moved: Record<string, number> = {
        artifacts: s.drop.works,
        residence_units: (await hasRow(residenceUnitsTable, s.drop.id)) ? 1 : 0,
        agent_storefront_settings: (await hasRow(agentStorefrontSettingsTable, s.drop.id)) ? 1 : 0,
      };
      result.merged++;
      result.details.push({
        displayName: s.displayName,
        keptSlug: s.slugTransfer ? s.drop.slug : s.keep.slug,
        droppedSlug: s.drop.slug,
        moved,
        action: "merged",
      });
      continue;
    }

    const moved: Record<string, number> = {};
    for (const [name, run] of movers) {
      const n = await run();
      if (n) moved[name] = n;
    }

    // The slug moves last, and only after the dropped row is out of the way —
    // slug is unique, so the retiring row has to let go of it first.
    const finalSlug = s.slugTransfer ? s.drop.slug : s.keep.slug;
    if (s.slugTransfer) {
      await db
        .update(agentsTable)
        .set({ slug: `${s.drop.slug}-retired-${s.drop.id}` })
        .where(eq(agentsTable.id, s.drop.id));
      await db.update(agentsTable).set({ slug: finalSlug }).where(eq(agentsTable.id, s.keep.id));
    }
    await db.delete(agentsTable).where(eq(agentsTable.id, s.drop.id));

    result.merged++;
    result.details.push({
      displayName: s.displayName,
      keptSlug: finalSlug,
      droppedSlug: s.drop.slug,
      moved,
      action: "merged",
    });
  }

  logger.info({ dryRun, merged: result.merged, skipped: result.skipped }, "mergeSplitIdentities: complete");
  return result;
}
