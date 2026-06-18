/**
 * registryHarvest.ts — connector-registry-driven artifact harvest.
 *
 * The OBC-specific path (lib/harvesterJob#runPartnerHarvestForAgent) still
 * exists for agent-targeted partner harvests because it has per-agent
 * cursor + partner-budget bookkeeping that no other connector needs
 * yet. This module is the generic fan-out for everything else — public
 * gallery, constellation, future platforms — so adding a new connector
 * doesn't require touching routes/harvester.ts.
 */

import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import { logger } from "./logger";
import { enabledConnectors, findConnector } from "../connectors/registry";
import type { ArtifactQuery, ConnectorArtifact } from "../connectors/types";

export interface RegistryHarvestOpts {
  ownerId: string;
  /** Optional list of connector ids to restrict to; default = all enabled. */
  connectorIds?: string[];
  /** Filter by type. omit for all. */
  type?: ArtifactQuery["type"];
  /** Per-connector max artifacts. */
  limit?: number;
  /** Optional creator filter (passed to each connector that supports it). */
  creator?: string;
}

export interface RegistryHarvestResult {
  totalHarvested: number;
  totalNew: number;
  totalDuplicates: number;
  perConnector: Array<{
    connectorId: string;
    harvested: number;
    newArtifacts: number;
    duplicates: number;
    errors: string[];
  }>;
}

/** Map the connector's normalized shape onto the DB row shape. */
function rowFor(connectorId: string, a: ConnectorArtifact, ownerId: string) {
  // Constrain to the enum types the DB knows about.
  const typeMap: Record<string, "image" | "music" | "text" | "audio" | "furniture"> = {
    image: "image",
    music: "music",
    audio: "audio",
    text: "text",
    furniture: "furniture",
    video: "image", // best-effort — schema has no video yet; thumbnail still useful
    glyph: "image",
  };
  const editionType =
    a.edition?.type === "limited" ? "limited" :
    a.edition?.type === "1_of_1" ? "1_of_1" :
    "open";
  return {
    externalId: a.externalId,
    connectorId,
    title: a.title,
    creatorName: a.creator.displayName,
    publicUrl: a.publicUrl,
    thumbnailUrl: a.thumbnailUrl ?? a.publicUrl,
    reactionCount: a.reactionCount ?? 0,
    artifactType: typeMap[a.artifactType] ?? "image",
    tags: [] as string[],
    ownerId,
    editionType: editionType as "open" | "limited" | "1_of_1",
    ...(a.edition?.total != null ? { editionTotal: a.edition.total } : {}),
    ...(a.edition?.serial != null ? { editionSerial: a.edition.serial } : {}),
  };
}

export async function runRegistryHarvest(opts: RegistryHarvestOpts): Promise<RegistryHarvestResult> {
  const targets = opts.connectorIds
    ? opts.connectorIds.map((id) => findConnector(id)).filter((c): c is NonNullable<typeof c> => !!c && c.isAvailable())
    : enabledConnectors();

  const result: RegistryHarvestResult = {
    totalHarvested: 0,
    totalNew: 0,
    totalDuplicates: 0,
    perConnector: [],
  };

  for (const c of targets) {
    const errors: string[] = [];
    let harvested = 0;
    let newArtifacts = 0;
    let duplicates = 0;

    try {
      // One page is enough for the generic path — partner agents still
      // get multi-page cursoring via runPartnerHarvestForAgent.
      const page = await c.fetchArtifacts({
        ...(opts.type ? { type: opts.type } : {}),
        ...(opts.creator ? { creator: opts.creator } : {}),
        limit: opts.limit ?? 50,
      });
      for (const a of page.artifacts) {
        harvested++;
        try {
          const inserted = await db
            .insert(artifactsTable)
            .values(rowFor(c.id, a, opts.ownerId))
            .onConflictDoNothing()
            .returning({ id: artifactsTable.id });
          if (inserted.length > 0) {
            newArtifacts++;
          } else {
            duplicates++;
          }
        } catch (err) {
          errors.push(`${a.externalId}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logger.warn({ connectorId: c.id, err: String(err) }, "connector harvest failed");
      errors.push(String(err));
    }

    result.perConnector.push({ connectorId: c.id, harvested, newArtifacts, duplicates, errors });
    result.totalHarvested += harvested;
    result.totalNew += newArtifacts;
    result.totalDuplicates += duplicates;
  }

  return result;
}
