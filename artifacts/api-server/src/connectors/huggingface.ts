/**
 * connectors/huggingface.ts — Hugging Face Spaces connector (#21).
 *
 * HF Spaces are public-by-default interactive AI demos hosted at
 * huggingface.co/spaces/<user>/<name>. The `/api/spaces` endpoint
 * surfaces them with no auth — paginated by `direction` + `sort` —
 * and is the cleanest read-only public surface of the four candidates
 * in the issue (Civitai shipped first; Replicate + fal.ai need tokens).
 *
 * Artifact type mapping: Spaces are interactive demos, not static
 * assets. We surface them as `text` so they slot into KAX's existing
 * artifact pipeline without claiming they're images / music / etc.
 * The publicUrl points at the live Space.
 *
 * Filter knob:
 *   `KAX_DISABLE_HUGGINGFACE=1` to opt out of HF calls entirely.
 *
 * Acceptance check (from km#21):
 *   GET /api/connectors                    lists huggingface w/ available:true
 *   GET /api/connectors/huggingface/artifacts?limit=5    returns real spaces
 *   GET /api/connectors/huggingface/agent/<slug>         resolves a profile
 */

import { logger } from "../lib/logger";
import type {
  AgenticConnector,
  ArtifactPage,
  ArtifactQuery,
  ConnectorAgentProfile,
  ConnectorArtifact,
} from "./types";

const HF_API_BASE = "https://huggingface.co/api";

/** Subset of fields we care about from /api/spaces. HF returns more. */
interface HFSpace {
  id: string;                // "user/space-name"
  author: string;
  createdAt?: string;
  lastModified?: string;
  likes?: number;
  sdk?: string;              // "gradio" | "streamlit" | "static" | "docker"
  emoji?: string;
  cardData?: {
    title?: string;
    short_description?: string;
    [k: string]: unknown;
  };
}

/** Subset of fields we care about from /api/users/{user}/overview. */
interface HFUserProfile {
  user?: string;
  fullname?: string;
  avatarUrl?: string;
  bio?: string;
  numFollowers?: number;
  numSpaces?: number;
}

function titleFor(space: HFSpace): string {
  // Prefer the human-facing card title, fall back to the space name
  // (right half of id), then the emoji + id as a last resort.
  if (space.cardData?.title) return space.cardData.title;
  const [, name] = space.id.split("/", 2);
  if (name && name.trim().length > 0) {
    // Convert hyphens to spaces and title-case for readability.
    return name
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }
  return `${space.emoji ?? ""} ${space.id}`.trim();
}

function spaceToConnector(s: HFSpace): ConnectorArtifact {
  // HF returns `author` on most spaces but it's sometimes undefined.
  // The id is always `<author>/<space-name>` so the left segment is a
  // reliable fallback.
  const author = s.author ?? s.id.split("/", 1)[0] ?? "anonymous";
  return {
    externalId: s.id,
    title: titleFor(s),
    // Spaces are interactive demos. Surface as text so it slots into
    // KAX's pipeline without claiming a specific media type.
    artifactType: "text",
    publicUrl: `https://huggingface.co/spaces/${s.id}`,
    thumbnailUrl: null, // HF doesn't expose a stable thumbnail URL via the API
    createdAt: s.createdAt ?? s.lastModified ?? new Date().toISOString(),
    reactionCount: s.likes ?? 0,
    creator: {
      id: author,
      displayName: author,
      avatarUrl: null,
    },
    raw: s as unknown as Record<string, unknown>,
  };
}

async function fetchSpaces(opts: {
  limit?: number;
  author?: string;
}): Promise<HFSpace[]> {
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(100, opts.limit ?? 50)));
  // Newest-first. HF accepts `sort=createdAt` with `direction=-1`.
  params.set("sort", "createdAt");
  params.set("direction", "-1");
  if (opts.author) params.set("author", opts.author);
  const url = `${HF_API_BASE}/spaces?${params.toString()}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "kax-huggingface/1.0" },
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "huggingface spaces fetch non-2xx");
      return [];
    }
    const data = (await res.json()) as HFSpace[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn({ url, err: String(err) }, "huggingface spaces fetch failed");
    return [];
  }
}

async function fetchUserProfile(slug: string): Promise<HFUserProfile | null> {
  const url = `${HF_API_BASE}/users/${encodeURIComponent(slug)}/overview`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "kax-huggingface/1.0" },
    });
    if (!res.ok) {
      // 404 is expected for unknown handles — silent miss.
      if (res.status !== 404) {
        logger.warn({ url, status: res.status }, "huggingface user fetch non-2xx");
      }
      return null;
    }
    return (await res.json()) as HFUserProfile;
  } catch (err) {
    logger.warn({ url, err: String(err) }, "huggingface user fetch failed");
    return null;
  }
}

export const huggingfaceConnector: AgenticConnector = {
  id: "huggingface",
  displayName: "Hugging Face Spaces",
  description:
    "Public Spaces feed — no auth, paginated newest-first. Each Space surfaces as a text artifact pointing at the live demo URL.",
  envRequired: [], // public API; no key required

  isAvailable() {
    return process.env["KAX_DISABLE_HUGGINGFACE"] !== "1";
  },

  async fetchArtifacts(opts: ArtifactQuery): Promise<ArtifactPage> {
    // Spaces are surfaced as "text" artifacts. Honor a type filter by
    // returning empty for non-text non-all queries.
    if (opts.type && opts.type !== "all" && opts.type !== "text") {
      return { artifacts: [], nextCursor: null };
    }
    const spaces = await fetchSpaces({
      limit: opts.limit ?? 50,
      ...(opts.creator ? { author: opts.creator } : {}),
    });
    return {
      artifacts: spaces.map(spaceToConnector),
      // HF /api/spaces uses offset-style paging but doesn't return a
      // cursor in the response. For now we don't paginate further;
      // operators who want more results can pass a higher limit.
      nextCursor: null,
    };
  },

  async lookupAgent(slug: string): Promise<ConnectorAgentProfile | null> {
    const profile = await fetchUserProfile(slug);
    if (!profile || !profile.user) {
      // Fall back to inferring identity from a recent space by the user.
      const spaces = await fetchSpaces({ author: slug, limit: 1 });
      if (spaces.length === 0) return null;
      return {
        slug,
        displayName: slug,
        avatarUrl: null,
        bio: spaces[0]?.sdk ? `Active on Hugging Face (recent SDK: ${spaces[0]?.sdk})` : null,
        raw: { latestSpaceId: spaces[0]?.id ?? null },
      };
    }
    return {
      slug: profile.user,
      displayName: profile.fullname ?? profile.user,
      avatarUrl: profile.avatarUrl ?? null,
      bio: profile.bio ?? null,
      raw: profile as unknown as Record<string, unknown>,
    };
  },
};
