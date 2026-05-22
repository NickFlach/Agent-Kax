/**
 * connectors/types.ts — pluggable agentic-platform connectors.
 *
 * KAX started as an OpenBotCity-only artifact harvester. The constellation
 * bridge added a second source. This module defines the abstract contract
 * any third agentic platform must satisfy to ship artifacts into KAX:
 *
 *   1. Tell us if you're configured/available right now
 *   2. List artifacts (page-able)
 *   3. Resolve an agent by handle
 *   4. (Optional) Receive outbound KAX events
 *
 * To add a new platform — Hugging Face Spaces, Civitai, Replicate, a
 * private agent collective, etc. — drop a new file under this folder,
 * implement `AgenticConnector`, and register it in `connectors/registry.ts`.
 * No harvester or route code needs to change.
 *
 * Connectors are stateless reads on top of upstream APIs. The DB shape
 * we land into is the existing `artifactsTable` (for harvest) and
 * `agentsTable` / `constellation_agents` (for discovery). Each
 * connector's job is to flatten its upstream shape into the
 * normalized `ConnectorArtifact` + `ConnectorAgentProfile` shapes here.
 */

export type ArtifactType = "image" | "audio" | "music" | "text" | "furniture" | "video" | "glyph";

export interface ConnectorArtifact {
  /** Stable, connector-side unique identifier. We dedupe on (connectorId, externalId). */
  externalId: string;
  title: string;
  artifactType: ArtifactType;
  publicUrl: string;
  thumbnailUrl?: string | null;
  createdAt: string; // ISO-8601
  reactionCount?: number;
  creator: {
    /** Connector-side identifier for the creator (slug, UUID, etc.). */
    id: string;
    displayName: string;
    avatarUrl?: string | null;
  };
  /** Optional edition info if the upstream supports scarcity. */
  edition?: {
    type: "open" | "limited" | "1_of_1";
    total?: number | null;
    serial?: number | null;
  };
  /** Free-form pass-through; whatever didn't fit above. */
  raw?: Record<string, unknown>;
}

export interface ConnectorAgentProfile {
  slug: string;
  displayName: string;
  avatarUrl?: string | null;
  bio?: string | null;
  /** Total artifact count if the connector knows it. */
  artifactCount?: number;
  /** Free-form pass-through. */
  raw?: Record<string, unknown>;
}

export interface ArtifactQuery {
  /** Filter by artifact type. omit for "all". */
  type?: ArtifactType | "all";
  /** Restrict to a specific creator (by connector-side id/slug). */
  creator?: string;
  /** Connector-specific pagination cursor. Pass null/undefined for the first page. */
  cursor?: string | null;
  /** Page size hint. Connectors may cap below this. */
  limit?: number;
}

export interface ArtifactPage {
  artifacts: ConnectorArtifact[];
  /** Pass back to fetchArtifacts() to continue; null when at end. */
  nextCursor: string | null;
}

/**
 * Outbound KAX event. Currently fired on:
 *   - "harvest.completed"     after /harvester/run lands new artifacts
 *   - "drop.published"        when a drop transitions to live
 *   - "artifact.scored"       when the taste engine rates something
 * Connectors that support push-back can subscribe to these.
 */
export interface KaxEvent {
  type: string;
  ts: number; // unix-ms
  agent_id?: string;
  data?: Record<string, unknown>;
}

export interface AgenticConnector {
  /** Stable id used as a foreign key on artifactsTable rows. Snake case. */
  readonly id: string;
  /** Human label for /api/connectors. */
  readonly displayName: string;
  /** Short description of what this connector wraps. */
  readonly description: string;
  /** Env vars (and any other prereqs) that must be set. Used by the registry to surface configuration hints. */
  readonly envRequired: string[];

  isAvailable(): boolean;

  fetchArtifacts(opts: ArtifactQuery): Promise<ArtifactPage>;

  lookupAgent(slug: string): Promise<ConnectorAgentProfile | null>;

  /** Optional outbound. No-op by default. */
  publish?(event: KaxEvent): Promise<void>;
}

export interface ConnectorStatus {
  id: string;
  displayName: string;
  description: string;
  available: boolean;
  envRequired: string[];
  envMissing: string[];
}
