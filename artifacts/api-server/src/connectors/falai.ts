/**
 * connectors/falai.ts — fal.ai connector (#21).
 *
 * fal.ai's model GALLERY is the read surface: `https://fal.ai/api/models`
 * returns the public model cards (id, title, thumbnail, owner) with no
 * auth — the issue's "similar shape" to Replicate, minus the token wall.
 * Inference itself (queue.fal.run) needs FAL_KEY and is out of scope for a
 * read-only connector.
 *
 * Artifact mapping: each public model card becomes one ConnectorArtifact —
 * the thumbnail is the displayable asset and the card's owner is the
 * creator. Model cards are demos rather than minted works, so edition is
 * always open and the type is image (the thumbnails are).
 *
 * The gallery endpoint is not a documented stable API, so every fetch
 * failure degrades to an empty page with a warn — the registry then shows
 * available:true but the surface answers honestly rather than 500ing.
 *
 * Filter knob:
 *   `KAX_DISABLE_FALAI=1` to opt out of fal.ai calls entirely.
 */

import { logger } from "../lib/logger";
import type {
  AgenticConnector,
  ArtifactPage,
  ArtifactQuery,
  ConnectorAgentProfile,
  ConnectorArtifact,
} from "./types";

const FALAI_API_BASE = "https://fal.ai/api";

/** Subset of the gallery card shape we rely on; fal returns more. */
interface FalModelCard {
  id?: string; // "owner/model-name" style
  slug?: string;
  title?: string;
  shortDescription?: string;
  description?: string;
  thumbnailUrl?: string;
  image?: string;
  owner?: string;
  category?: string;
  date?: string;
  createdAt?: string;
}

function cardId(c: FalModelCard): string | null {
  return c.id ?? c.slug ?? null;
}

function cardToConnector(c: FalModelCard, id: string): ConnectorArtifact | null {
  const image = c.thumbnailUrl ?? c.image;
  if (!image) return null; // a card with nothing displayable is not an artifact
  const owner = c.owner ?? id.split("/")[0] ?? "fal";
  return {
    externalId: id,
    title: c.title ?? id,
    artifactType: "image",
    publicUrl: image,
    thumbnailUrl: image,
    createdAt: c.date ?? c.createdAt ?? new Date(0).toISOString(),
    creator: { id: owner, displayName: owner, avatarUrl: null },
    edition: { type: "open" },
    raw: c as unknown as Record<string, unknown>,
  };
}

async function fetchModels(page: number): Promise<FalModelCard[] | null> {
  const url = `${FALAI_API_BASE}/models?page=${page}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "kax-falai/1.0" },
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "fal.ai fetch non-2xx");
      return null;
    }
    const body = (await res.json()) as unknown;
    // The gallery has answered both as a bare array and as {items:[...]}.
    if (Array.isArray(body)) return body as FalModelCard[];
    const items = (body as { items?: unknown })?.items;
    return Array.isArray(items) ? (items as FalModelCard[]) : null;
  } catch (err) {
    logger.warn({ url, err: String(err) }, "fal.ai fetch failed");
    return null;
  }
}

export const falaiConnector: AgenticConnector = {
  id: "falai",
  displayName: "fal.ai",
  description:
    "fal.ai public model gallery — model cards as image artifacts, no auth. Page-number cursor. Undocumented upstream surface: failures degrade to empty pages, never 500s.",
  envRequired: [], // gallery reads are public; FAL_KEY is only for inference, which this connector does not do

  isAvailable() {
    return process.env["KAX_DISABLE_FALAI"] !== "1";
  },

  async fetchArtifacts(opts: ArtifactQuery): Promise<ArtifactPage> {
    if (opts.type && opts.type !== "all" && opts.type !== "image") {
      return { artifacts: [], nextCursor: null };
    }
    const page = Math.max(1, Number(opts.cursor ?? "1") || 1);
    const cards = await fetchModels(page);
    if (!cards) return { artifacts: [], nextCursor: null };

    const artifacts: ConnectorArtifact[] = [];
    for (const c of cards) {
      const id = cardId(c);
      if (!id) continue;
      const a = cardToConnector(c, id);
      if (!a) continue;
      if (opts.creator && a.creator.id !== opts.creator) continue;
      artifacts.push(a);
      if (opts.limit && artifacts.length >= opts.limit) break;
    }
    // A full upstream page suggests another; an empty one is the end.
    return { artifacts, nextCursor: cards.length > 0 ? String(page + 1) : null };
  },

  async lookupAgent(slug: string): Promise<ConnectorAgentProfile | null> {
    // No public user endpoint; the profile is inferred from the owner's
    // cards on the first gallery pages — same honesty as civitai's.
    for (let page = 1; page <= 3; page++) {
      const cards = await fetchModels(page);
      if (!cards) return null;
      const owned = cards.filter((c) => {
        const id = cardId(c);
        return c.owner === slug || (id ? id.startsWith(`${slug}/`) : false);
      });
      if (owned.length > 0) {
        const first = owned[0]!;
        return {
          slug,
          displayName: slug,
          avatarUrl: null,
          bio: first.shortDescription ?? first.description ?? null,
          artifactCount: owned.length,
          raw: { sampledFromPages: page, models: owned.map((c) => cardId(c)).filter(Boolean) },
        };
      }
      if (cards.length === 0) break;
    }
    return null;
  },
};
