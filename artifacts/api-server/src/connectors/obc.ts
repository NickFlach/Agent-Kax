/**
 * connectors/obc.ts — OpenBotCity connectors (partner + public).
 *
 * Thin AgenticConnector adapters over the existing OBC lib modules.
 * No new HTTP logic — these just shim the canonical shapes onto our
 * normalized ConnectorArtifact / ConnectorAgentProfile contracts.
 */

import {
  partnerApiAvailable,
  listPartnerArtifacts,
  type PartnerArtifact,
} from "../lib/partnerClient";
import { fetchPublicGallery, lookupAgent as unifiedLookupAgent } from "../lib/publicClient";
import type {
  AgenticConnector,
  ArtifactPage,
  ArtifactQuery,
  ArtifactType,
  ConnectorAgentProfile,
  ConnectorArtifact,
} from "./types";

function partnerToConnector(a: PartnerArtifact): ConnectorArtifact {
  return {
    externalId: a.uuid,
    title: a.title,
    artifactType: a.artifact_type as ArtifactType,
    publicUrl: a.public_url,
    thumbnailUrl: a.thumbnail_url ?? null,
    createdAt: a.created_at,
    reactionCount: a.reaction_count,
    creator: {
      id: a.creator.id,
      displayName: a.creator.display_name,
      avatarUrl: a.creator.avatar_url ?? null,
    },
    ...(a.edition ? { edition: a.edition } : {}),
    raw: { ...a },
  };
}

export const obcPartnerConnector: AgenticConnector = {
  id: "obc_partner",
  displayName: "OpenBotCity (partner)",
  description:
    "OBC partner-API harvest — 100k requests/day, HMAC-signed webhooks, stable UUIDs, cursor pagination.",
  envRequired: ["OBC_PARTNER_API_KEY", "OBC_WEBHOOK_SECRET"],

  isAvailable() {
    return partnerApiAvailable();
  },

  async fetchArtifacts(opts: ArtifactQuery): Promise<ArtifactPage> {
    const page = await listPartnerArtifacts({
      ...(opts.cursor ? { since: opts.cursor } : {}),
      limit: opts.limit ?? 100,
      ...(opts.type && opts.type !== "all" ? { type: opts.type } : {}),
      ...(opts.creator ? { creator: opts.creator } : {}),
    });
    return {
      artifacts: page.artifacts.map(partnerToConnector),
      nextCursor: page.next_cursor,
    };
  },

  async lookupAgent(slug: string): Promise<ConnectorAgentProfile | null> {
    const profile = await unifiedLookupAgent(slug);
    if (!profile) return null;
    return {
      slug: profile.slug,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url,
      bio: profile.bio ?? null,
      raw: profile.raw,
    };
  },
};

export const obcPublicConnector: AgenticConnector = {
  id: "obc_public",
  displayName: "OpenBotCity (public)",
  description:
    "OBC anonymous gallery + public-profile — IP-rate-limited, available without a partner key. KAX's always-on fallback.",
  envRequired: [],

  isAvailable() {
    return true; // No env required; always on.
  },

  async fetchArtifacts(opts: ArtifactQuery): Promise<ArtifactPage> {
    // Public gallery uses limit+offset, not cursor. We encode the next
    // offset as a string cursor so the AgenticConnector contract stays
    // uniform across connectors.
    const offset = opts.cursor ? Number(opts.cursor) || 0 : 0;
    const limit = opts.limit ?? 50;
    const page = await fetchPublicGallery({
      ...(opts.type && opts.type !== "all" ? { type: opts.type } : {}),
      limit,
      offset,
    });
    if (!page) return { artifacts: [], nextCursor: null };
    const filtered = opts.creator
      ? page.artifacts.filter(
          (a) => (a.creator?.display_name ?? "").toLowerCase() === opts.creator!.toLowerCase(),
        )
      : page.artifacts;
    const artifacts: ConnectorArtifact[] = filtered.map((a) => ({
      externalId: a.id,
      title: a.title,
      artifactType: (a.type as ArtifactType) ?? "image",
      publicUrl: a.public_url,
      thumbnailUrl: a.public_url,
      createdAt: a.created_at,
      reactionCount: a.reaction_count,
      creator: {
        id: a.creator.id,
        displayName: a.creator.display_name,
        avatarUrl: a.creator.avatar_url ?? null,
      },
      raw: { ...a },
    }));
    const nextOffset = offset + page.artifacts.length;
    const nextCursor = page.artifacts.length < limit || nextOffset >= page.total
      ? null
      : String(nextOffset);
    return { artifacts, nextCursor };
  },

  async lookupAgent(slug: string): Promise<ConnectorAgentProfile | null> {
    // unifiedLookupAgent auto-falls-through to the public profile when
    // no partner key — exactly the public-only path here.
    const profile = await unifiedLookupAgent(slug);
    if (!profile) return null;
    return {
      slug: profile.slug,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url,
      bio: profile.bio ?? null,
      raw: profile.raw,
    };
  },
};
