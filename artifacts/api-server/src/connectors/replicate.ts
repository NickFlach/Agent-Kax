/**
 * connectors/replicate.ts — Replicate connector (#21).
 *
 * Replicate's API is token-gated end to end (`REPLICATE_API_TOKEN`), so
 * unlike civitai/huggingface this connector reports available:false until
 * the operator sets one — and fetchArtifacts refuses locally rather than
 * burning a doomed network call.
 *
 * Artifact mapping: `GET /v1/predictions` lists the token account's own
 * predictions — the actual generated outputs (images / audio / video),
 * which is what the issue calls the artifacts. Each SUCCEEDED prediction
 * with at least one output URL becomes one ConnectorArtifact; the type is
 * inferred from the output file extension and the model name stands in as
 * the title. Pagination is Replicate's `next` URL, passed back verbatim
 * as the cursor.
 *
 * lookupAgent: Replicate has no public user endpoint. A slug containing
 * a slash is resolved as a MODEL path via `GET /v1/models/{owner}/{name}`
 * and the profile describes the model's owner; a bare slug is checked
 * against `GET /v1/account` (the token's own identity). Documented
 * limitation, honest rather than scraped.
 */

import { logger } from "../lib/logger";
import type {
  AgenticConnector,
  ArtifactPage,
  ArtifactQuery,
  ArtifactType,
  ConnectorAgentProfile,
  ConnectorArtifact,
} from "./types";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

interface ReplicatePrediction {
  id: string;
  model?: string;
  version?: string;
  status: string; // starting | processing | succeeded | failed | canceled
  created_at: string;
  output?: unknown; // commonly string | string[] of URLs
  metrics?: Record<string, unknown>;
}

interface ReplicatePredictionsResponse {
  results: ReplicatePrediction[];
  next?: string | null;
}

interface ReplicateModel {
  owner: string;
  name: string;
  description?: string;
  cover_image_url?: string;
  run_count?: number;
  url?: string;
}

function token(): string | undefined {
  const t = process.env["REPLICATE_API_TOKEN"];
  return t && t.trim() !== "" ? t : undefined;
}

async function apiGet<T>(url: string): Promise<T | null> {
  const t = token();
  if (!t) return null;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${t}`, Accept: "application/json", "User-Agent": "kax-replicate/1.0" },
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "replicate fetch non-2xx");
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ url, err: String(err) }, "replicate fetch failed");
    return null;
  }
}

/** Infer the artifact type from an output URL's extension. */
export function typeOfOutputUrl(url: string): ArtifactType {
  const ext = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(url)?.[1]?.toLowerCase() ?? "";
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov", "gif"].includes(ext)) return "video";
  if (["txt", "json", "md"].includes(ext)) return "text";
  return "image"; // png/jpg/webp and the unknown-extension common case
}

/** First plausible output URL of a prediction, if any. */
function firstOutputUrl(output: unknown): string | null {
  const candidates = Array.isArray(output) ? output : [output];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//i.test(c)) return c;
  }
  return null;
}

function predictionToConnector(p: ReplicatePrediction, url: string): ConnectorArtifact {
  const owner = p.model?.split("/")[0] ?? "replicate";
  return {
    externalId: p.id,
    title: p.model ? `${p.model} output` : `Replicate prediction ${p.id.slice(0, 8)}`,
    artifactType: typeOfOutputUrl(url),
    publicUrl: url,
    thumbnailUrl: null,
    createdAt: p.created_at,
    creator: { id: owner, displayName: owner, avatarUrl: null },
    raw: p as unknown as Record<string, unknown>,
  };
}

export const replicateConnector: AgenticConnector = {
  id: "replicate",
  displayName: "Replicate",
  description:
    "Replicate predictions (the token account's generated outputs — images/audio/video). Token-gated: set REPLICATE_API_TOKEN. Cursor is Replicate's own `next` URL.",
  envRequired: ["REPLICATE_API_TOKEN"],

  isAvailable() {
    return token() !== undefined;
  },

  async fetchArtifacts(opts: ArtifactQuery): Promise<ArtifactPage> {
    if (!this.isAvailable()) return { artifacts: [], nextCursor: null };
    const url = opts.cursor ?? `${REPLICATE_API_BASE}/predictions`;
    const page = await apiGet<ReplicatePredictionsResponse>(url);
    if (!page) return { artifacts: [], nextCursor: null };

    const wanted = opts.type && opts.type !== "all" ? opts.type : null;
    const artifacts: ConnectorArtifact[] = [];
    for (const p of page.results ?? []) {
      if (p.status !== "succeeded") continue;
      const out = firstOutputUrl(p.output);
      if (!out) continue;
      const a = predictionToConnector(p, out);
      if (wanted && a.artifactType !== wanted) continue;
      if (opts.creator && a.creator.id !== opts.creator) continue;
      artifacts.push(a);
      if (opts.limit && artifacts.length >= opts.limit) break;
    }
    return { artifacts, nextCursor: page.next ?? null };
  },

  async lookupAgent(slug: string): Promise<ConnectorAgentProfile | null> {
    if (!this.isAvailable()) return null;
    if (slug.includes("/")) {
      const model = await apiGet<ReplicateModel>(`${REPLICATE_API_BASE}/models/${slug}`);
      if (!model) return null;
      return {
        slug: model.owner,
        displayName: model.owner,
        avatarUrl: null,
        bio: model.description ?? null,
        raw: { model: `${model.owner}/${model.name}`, runCount: model.run_count ?? null, url: model.url ?? null },
      };
    }
    const account = await apiGet<{ username?: string; name?: string; github_url?: string }>(
      `${REPLICATE_API_BASE}/account`,
    );
    if (!account?.username || account.username !== slug) return null;
    return {
      slug: account.username,
      displayName: account.name ?? account.username,
      avatarUrl: null,
      bio: null,
      raw: { githubUrl: account.github_url ?? null },
    };
  },
};
