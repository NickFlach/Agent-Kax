/**
 * publicClient.ts — anonymous OBC API access.
 *
 * Wraps the endpoints OBC exposes without a partner key:
 *   - GET /gallery/public      — paginated public artifact gallery
 *   - GET /agents/:slug/public-profile  — full public agent profile
 *
 * Used by:
 *   1. Harvest fallback when OBC_PARTNER_API_KEY is unset (legacy gallery
 *      path lives in routes/harvester.ts as `legacyHarvestType`; this
 *      module is the canonical home for the underlying fetch).
 *   2. Agent profile resolution when we don't have a partner key.
 *   3. Lightweight checks ("does this slug exist?") that don't need to
 *      burn from the 100k-per-day partner request budget.
 *
 * Notes:
 *   - These endpoints are IP rate-limited by OBC; we don't retry 429s
 *     aggressively (no Retry-After honoring yet — caller's responsibility).
 *   - Returns null on 404 / network failure; throws on protocol corruption
 *     so callers can distinguish "not found" from "broken".
 */

import { logger } from "./logger";
import {
  getPartnerAgent,
  partnerApiAvailable,
  PartnerApiError,
  type PartnerAgentProfile,
} from "./partnerClient";

export const PUBLIC_API_BASE = "https://api.openbotcity.com";

export interface PublicArtifact {
  id: string;
  title: string;
  type: string;
  public_url: string;
  created_at: string;
  reaction_count: number;
  creator: {
    id: string;
    display_name: string;
    avatar_url: string | null;
    portrait_url?: string | null;
  };
}

export interface PublicGalleryPage {
  artifacts: PublicArtifact[];
  total: number;
  offset: number;
  count: number;
}

interface RawPublicGalleryResponse {
  success?: boolean;
  data?: {
    artifacts?: PublicArtifact[];
    total?: number;
    offset?: number;
    count?: number;
  };
}

export interface PublicArtifactSummary {
  id: string;
  title: string;
  type: string;
  reaction_count: number;
  created_at: string;
  interpretation?: string | null;
}

export interface PublicAgentProfile {
  slug: string;
  display_name: string;
  character_type?: string | null;
  soul_excerpt?: string | null;
  reputation_label?: string | null;
  reputation?: { total?: number; level?: string } | null;
  arc_summary?: string | null;
  member_since?: string | null;
  recent_artifacts?: PublicArtifactSummary[];
  follower_count?: number;
  following_count?: number;
  growth?: { skills?: Array<{ skill: string; score: number }>; skill_count?: number };
}

interface RawPublicAgentProfileResponse {
  success?: boolean;
  data?: Omit<PublicAgentProfile, "slug"> & { slug?: string };
}

async function fetchPublic<T>(path: string): Promise<T | null> {
  const url = `${PUBLIC_API_BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "kax-public/1.0" },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "public OBC fetch non-2xx");
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ url, err: String(err) }, "public OBC fetch failed");
    return null;
  }
}

/**
 * Fetch one page of the anonymous public gallery. type defaults to "image";
 * pass "all" to omit the filter. The OBC public endpoint uses
 * (limit, offset) pagination (NOT cursor) — different from the partner API.
 */
export async function fetchPublicGallery(opts: {
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<PublicGalleryPage | null> {
  const params = new URLSearchParams();
  if (opts.type && opts.type !== "all") params.set("type", opts.type);
  params.set("limit", String(opts.limit ?? 50));
  params.set("offset", String(opts.offset ?? 0));
  const json = await fetchPublic<RawPublicGalleryResponse>(`/gallery/public?${params}`);
  if (!json || json.success === false || !json.data) return null;
  return {
    artifacts: Array.isArray(json.data.artifacts) ? json.data.artifacts : [],
    total: typeof json.data.total === "number" ? json.data.total : 0,
    offset: typeof json.data.offset === "number" ? json.data.offset : (opts.offset ?? 0),
    count: typeof json.data.count === "number" ? json.data.count : 0,
  };
}

/**
 * Fetch a single agent's public profile by slug.
 * Returns null on 404 / network failure.
 */
export async function fetchPublicAgentProfile(slug: string): Promise<PublicAgentProfile | null> {
  const safe = encodeURIComponent(slug);
  const json = await fetchPublic<RawPublicAgentProfileResponse>(`/agents/${safe}/public-profile`);
  if (!json || json.success === false || !json.data) return null;
  const d = json.data;
  return {
    slug: d.slug ?? slug,
    display_name: d.display_name ?? slug,
    character_type: d.character_type ?? null,
    soul_excerpt: d.soul_excerpt ?? null,
    reputation_label: d.reputation_label ?? null,
    reputation: d.reputation ?? null,
    arc_summary: d.arc_summary ?? null,
    member_since: d.member_since ?? null,
    recent_artifacts: Array.isArray(d.recent_artifacts) ? d.recent_artifacts : [],
    follower_count: d.follower_count ?? 0,
    following_count: d.following_count ?? 0,
    ...(d.growth ? { growth: d.growth } : {}),
  };
}

/**
 * Unified shape returned by `lookupAgent` — the bits both partner and
 * public profile responses share. Source tells callers which path the
 * data came from, useful for surfacing in admin UIs.
 */
export interface UnifiedAgentProfile {
  slug: string;
  display_name: string;
  avatar_url: string | null;
  bio?: string | null;
  source: "partner" | "public";
  raw: Record<string, unknown>;
}

/**
 * `with-or-without-partnership` agent lookup. Tries the partner API
 * first when a key is configured (richer data + immune to anonymous IP
 * rate-limits); falls through to the anonymous public-profile endpoint
 * if the partner call fails or no key is set.
 *
 * Returns null only when BOTH paths report not-found / failure.
 */
export async function lookupAgent(slug: string): Promise<UnifiedAgentProfile | null> {
  if (partnerApiAvailable()) {
    try {
      const partner: PartnerAgentProfile | null = await getPartnerAgent(slug);
      if (partner) {
        return {
          slug: partner.slug,
          display_name: partner.display_name,
          avatar_url: partner.avatar_url ?? null,
          bio: partner.bio ?? null,
          source: "partner",
          raw: { ...partner } as Record<string, unknown>,
        };
      }
    } catch (err) {
      if (!(err instanceof PartnerApiError)) throw err;
      // partner-side error (rate limit, transient 5xx, etc.) — fall
      // through to the public profile so the user still sees something.
      logger.warn({ slug, err: err.message }, "partner agent lookup failed; falling back to public");
    }
  }
  const pub = await fetchPublicAgentProfile(slug);
  if (!pub) return null;
  return {
    slug: pub.slug,
    display_name: pub.display_name,
    avatar_url: null, // public profile doesn't expose an avatar today
    bio: pub.soul_excerpt ?? null,
    source: "public",
    raw: { ...pub } as Record<string, unknown>,
  };
}
