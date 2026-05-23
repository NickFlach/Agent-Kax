/**
 * connectors/civitai.ts — Civitai images connector (#21).
 *
 * Civitai's public image API requires no auth for read access. We pull
 * the global /api/v1/images feed sorted Newest, filtered nsfw=false,
 * and surface each image as a `ConnectorArtifact` with the Civitai
 * username as the creator. `lookupAgent` returns the minimum profile
 * inferred from the user's most recent image (their users endpoint
 * requires auth).
 *
 * Native edition support: Civitai images don't carry edition metadata
 * (they're rendered, not minted), so we always report `open`.
 *
 * Filter knob:
 *   `CIVITAI_NSFW=on` env to drop the nsfw=false filter. Default off.
 */

import { logger } from "../lib/logger";
import type {
  AgenticConnector,
  ArtifactPage,
  ArtifactQuery,
  ConnectorAgentProfile,
  ConnectorArtifact,
} from "./types";

const CIVITAI_API_BASE = "https://civitai.com/api/v1";

interface CivitaiImage {
  id: number;
  url: string;
  width?: number;
  height?: number;
  type?: string;
  nsfw?: boolean;
  createdAt: string;
  postId?: number;
  username?: string;
  baseModel?: string;
  meta?: {
    prompt?: string;
    [k: string]: unknown;
  };
  stats?: {
    likeCount?: number;
    heartCount?: number;
    commentCount?: number;
    [k: string]: unknown;
  };
}

interface CivitaiImagesResponse {
  items: CivitaiImage[];
  metadata?: {
    nextCursor?: string | null;
    nextPage?: string;
  };
}

function titleFromPrompt(prompt: string | undefined, id: number): string {
  if (!prompt) return `Civitai image #${id}`;
  // Strip noisy LoRA / score / commas-of-prompt-engineering; take the
  // first sentence-like chunk so KAX surfaces something human-readable.
  const cleaned = prompt
    .replace(/<lora:[^>]+>/gi, "")
    .replace(/\(+|\)+/g, "")
    .replace(/score_\d+,?/gi, "")
    .replace(/,+/g, ",")
    .trim();
  const first = cleaned.split(/[\n.,;]/).find((s) => s.trim().length > 5);
  const title = (first ?? cleaned).trim();
  return title.length > 80 ? title.slice(0, 77) + "…" : title || `Civitai image #${id}`;
}

function imageToConnector(i: CivitaiImage): ConnectorArtifact {
  const reactionCount =
    (i.stats?.likeCount ?? 0) +
    (i.stats?.heartCount ?? 0);
  return {
    externalId: String(i.id),
    title: titleFromPrompt(i.meta?.prompt, i.id),
    artifactType: "image",
    publicUrl: i.url,
    thumbnailUrl: i.url,
    createdAt: i.createdAt,
    reactionCount,
    creator: {
      id: i.username ?? "anonymous",
      displayName: i.username ?? "anonymous",
      avatarUrl: null,
    },
    raw: i as unknown as Record<string, unknown>,
  };
}

async function fetchImages(opts: {
  cursor?: string | null;
  limit?: number;
  username?: string;
}): Promise<CivitaiImagesResponse | null> {
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(200, opts.limit ?? 50)));
  params.set("sort", "Newest");
  if (!process.env["CIVITAI_NSFW"] || process.env["CIVITAI_NSFW"] !== "on") {
    params.set("nsfw", "false");
  }
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.username) params.set("username", opts.username);
  const url = `${CIVITAI_API_BASE}/images?${params.toString()}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "kax-civitai/1.0" },
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "civitai fetch non-2xx");
      return null;
    }
    return (await res.json()) as CivitaiImagesResponse;
  } catch (err) {
    logger.warn({ url, err: String(err) }, "civitai fetch failed");
    return null;
  }
}

export const civitaiConnector: AgenticConnector = {
  id: "civitai",
  displayName: "Civitai",
  description:
    "Civitai public image feed — no auth, paginated by cursor. Surfaces creator usernames + per-image stats. NSFW filtered by default; set CIVITAI_NSFW=on to include.",
  envRequired: [], // public API; no key required

  isAvailable() {
    // Toggle off with `KAX_DISABLE_CIVITAI=1` for operators who don't
    // want any third-party calls. Otherwise always on.
    return process.env["KAX_DISABLE_CIVITAI"] !== "1";
  },

  async fetchArtifacts(opts: ArtifactQuery): Promise<ArtifactPage> {
    // Civitai only returns images; honor the type filter by returning
    // an empty page on non-image queries.
    if (opts.type && opts.type !== "all" && opts.type !== "image") {
      return { artifacts: [], nextCursor: null };
    }
    const page = await fetchImages({
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
      limit: opts.limit ?? 50,
      ...(opts.creator ? { username: opts.creator } : {}),
    });
    if (!page) return { artifacts: [], nextCursor: null };
    return {
      artifacts: page.items.map(imageToConnector),
      nextCursor: page.metadata?.nextCursor ?? null,
    };
  },

  async lookupAgent(slug: string): Promise<ConnectorAgentProfile | null> {
    // Civitai's /users/:username requires auth, so we infer the
    // profile from the most-recent image by that username (which the
    // images API freely returns).
    const page = await fetchImages({ username: slug, limit: 1 });
    if (!page || page.items.length === 0) return null;
    const first = page.items[0]!;
    return {
      slug: first.username ?? slug,
      displayName: first.username ?? slug,
      avatarUrl: null,
      bio: first.baseModel ? `Recent base model: ${first.baseModel}` : null,
      raw: {
        latestImageId: first.id,
        latestImageAt: first.createdAt,
        latestPrompt: first.meta?.prompt ?? null,
      },
    };
  },
};
