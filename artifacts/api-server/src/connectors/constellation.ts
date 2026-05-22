/**
 * connectors/constellation.ts — Kannaka constellation NATS connector.
 *
 * Surfaces the constellation_agents + constellation_artifacts mirror
 * tables (fed by lib/constellationBridge) through the AgenticConnector
 * contract. Reads-only — write-back happens by `publish` lifting events
 * up to the bridge module which knows how to envelope them.
 */

import { db } from "@workspace/db";
import { constellationAgentsTable, constellationArtifactsTable } from "@workspace/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { isConnected, publish as publishConstellation } from "../lib/constellationBridge";
import type {
  AgenticConnector,
  ArtifactPage,
  ArtifactQuery,
  ArtifactType,
  ConnectorAgentProfile,
  ConnectorArtifact,
  KaxEvent,
} from "./types";

export const constellationConnector: AgenticConnector = {
  id: "kannaka_constellation",
  displayName: "Kannaka constellation",
  description:
    "NATS bus mirror — swarm members announce via QUEEN.*; radio + observatory publish artifacts via *.events.>; KAX surfaces them locally and can publish back.",
  envRequired: ["KAX_NATS_URL"],

  isAvailable() {
    // Live bridge is the strongest signal; presence of NATS_URL is the
    // configuration intent even if the connection's currently retrying.
    return isConnected() || !!process.env["KAX_NATS_URL"];
  },

  async fetchArtifacts(opts: ArtifactQuery): Promise<ArtifactPage> {
    const limit = opts.limit ?? 50;
    const offset = opts.cursor ? Number(opts.cursor) || 0 : 0;

    const conditions = [];
    if (opts.type && opts.type !== "all") {
      conditions.push(eq(constellationArtifactsTable.artifactType, opts.type));
    }
    if (opts.creator) {
      conditions.push(eq(constellationArtifactsTable.originAgentId, opts.creator));
    }

    const baseQuery = db
      .select()
      .from(constellationArtifactsTable)
      .orderBy(desc(constellationArtifactsTable.publishedAt))
      .limit(limit)
      .offset(offset);
    const rows =
      conditions.length === 0
        ? await baseQuery
        : await baseQuery.where(sql.join(conditions, sql` AND `));

    const artifacts: ConnectorArtifact[] = rows.map((r) => ({
      externalId: String(r.id),
      title: r.title ?? "Untitled",
      artifactType: r.artifactType as ArtifactType,
      publicUrl: r.publicUrl,
      thumbnailUrl: r.thumbnailUrl,
      createdAt: r.publishedAt.toISOString(),
      reactionCount: 0,
      creator: {
        id: r.originAgentId,
        displayName: r.originAgentId,
        avatarUrl: null,
      },
      raw: { source: r.source, metadata: r.metadata },
    }));
    const nextCursor = rows.length < limit ? null : String(offset + rows.length);
    return { artifacts, nextCursor };
  },

  async lookupAgent(slug: string): Promise<ConnectorAgentProfile | null> {
    const [row] = await db
      .select()
      .from(constellationAgentsTable)
      .where(eq(constellationAgentsTable.agentId, slug))
      .limit(1);
    if (!row) return null;
    return {
      slug: row.agentId,
      displayName: row.displayName,
      avatarUrl: null,
      bio: row.consciousnessLevel ? `Consciousness: ${row.consciousnessLevel}` : null,
      raw: {
        agentId: row.agentId,
        source: row.source,
        phi: row.phi,
        consciousness_level: row.consciousnessLevel,
        first_seen_at: row.firstSeenAt.toISOString(),
        last_seen_at: row.lastSeenAt.toISOString(),
        metadata: row.metadata,
      },
    };
  },

  async publish(event: KaxEvent): Promise<void> {
    await publishConstellation(`KAX.events.${event.type}`, {
      ...(event.data ?? {}),
      ts: event.ts,
    });
  },
};
