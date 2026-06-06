/**
 * creatorDirectory.ts — resolve OBC bot UUID -> creator display name via the
 * PUBLIC gallery API.
 *
 * Why this exists: the OBC *partner* feed (and single-artifact endpoint) only
 * carry `creator_bot_id` — never a display name — and there is no
 * uuid->agent reverse lookup. The *public* gallery
 * (`GET /gallery/public`), however, returns each artifact's
 * `creator: { id, display_name, avatar_url }`, where `creator.id` is the SAME
 * value as the partner feed's `creator_bot_id` (verified). It needs no API key
 * and does not draw from the partner request budget, so it is the canonical
 * place to put a name to a bot UUID.
 *
 * Two access patterns:
 *   - `ensureCreatorName(botId)` — lazy, bounded lookup used at harvest time
 *     when a brand-new creator first appears (their work is recent, so it sits
 *     near the top of the newest-first gallery and is usually found on page 0).
 *   - `buildFullCreatorDirectory()` — one full catalog walk used by the
 *     one-time attribution repair, yielding both a bot->name map and an
 *     artifact->bot map for the entire public catalog.
 *
 * Both share a process-level name cache so repeated lookups are free.
 */

import { logger } from "./logger";

const PUBLIC_API_BASE = "https://api.openbotcity.com";
const PAGE_LIMIT = 100;
/** Max attempts per page before giving up (covers 429 / 5xx / network blips). */
const MAX_FETCH_ATTEMPTS = 6;
/** Polite delay between successful catalog pages to avoid tripping rate limits. */
const GALLERY_PAGE_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export interface CreatorInfo {
  displayName: string;
  avatarUrl: string | null;
}

const nameCache = new Map<string, CreatorInfo>();

interface RawGalleryArtifact {
  id: string;
  creator?: { id?: string; display_name?: string; avatar_url?: string | null };
}

interface RawGalleryResponse {
  success?: boolean;
  data?: {
    artifacts?: RawGalleryArtifact[];
    total?: number;
    count?: number;
    offset?: number;
  };
}

interface GalleryPage {
  /** artifactId -> creator bot id, for every artifact on the page. */
  artifactToCreator: Array<{ artifactId: string; creatorId: string }>;
  total: number;
  returned: number;
}

async function fetchGalleryPage(offset: number): Promise<GalleryPage> {
  const url = `${PUBLIC_API_BASE}/gallery/public?limit=${PAGE_LIMIT}&offset=${offset}`;
  // The public gallery aggressively rate-limits (HTTP 429) the long
  // full-catalog walk. Retry transient failures (429 / 5xx / network blip)
  // with exponential backoff + jitter, honoring Retry-After when present, so a
  // single 429 doesn't abort the entire walk (and, by extension, the
  // backgrounded attribution repair). Each attempt is independently bounded by
  // a 20s timeout so a hung connection can't stall indefinitely.
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      await sleep(backoff + Math.floor(Math.random() * 500));
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      lastErr = err; // network error / timeout — retry
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`public gallery ${res.status} at offset ${offset}`);
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      if (retryAfter != null) await sleep(Math.min(retryAfter, 60_000));
      continue;
    }
    if (!res.ok) {
      // Non-retryable client error (e.g. 400/404) — fail fast.
      throw new Error(`public gallery ${res.status} at offset ${offset}`);
    }
    const json = (await res.json()) as RawGalleryResponse;
    const arts = json.data?.artifacts ?? [];
    const artifactToCreator: GalleryPage["artifactToCreator"] = [];
    for (const a of arts) {
      const creatorId = a.creator?.id;
      if (!creatorId) continue;
      artifactToCreator.push({ artifactId: a.id, creatorId });
      const name = a.creator?.display_name?.trim();
      if (name && !nameCache.has(creatorId)) {
        nameCache.set(creatorId, { displayName: name, avatarUrl: a.creator?.avatar_url ?? null });
      }
    }
    return { artifactToCreator, total: json.data?.total ?? 0, returned: arts.length };
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`public gallery failed after ${MAX_FETCH_ATTEMPTS} attempts at offset ${offset}`);
}

/**
 * Best-effort name for a single bot id. Returns cached value immediately, else
 * walks the newest-first public gallery up to `MAX_LAZY_PAGES` (recent works)
 * looking for it. Returns null if not found within that bound — callers fall
 * back to a uuid-derived placeholder name.
 */
export async function ensureCreatorName(botId: string): Promise<CreatorInfo | null> {
  if (nameCache.has(botId)) return nameCache.get(botId) ?? null;
  const MAX_LAZY_PAGES = 8; // ~800 most-recent artifacts
  let total = Infinity;
  for (let page = 0; page < MAX_LAZY_PAGES; page++) {
    const offset = page * PAGE_LIMIT;
    if (offset >= total) break;
    let res: GalleryPage;
    try {
      res = await fetchGalleryPage(offset);
    } catch (err) {
      logger.warn({ err, botId }, "ensureCreatorName: gallery page fetch failed");
      break;
    }
    total = res.total || total;
    if (nameCache.has(botId)) return nameCache.get(botId) ?? null;
    if (res.returned === 0) break;
  }
  return nameCache.get(botId) ?? null;
}

export interface CreatorDirectory {
  /** bot id -> { displayName, avatarUrl } for every named creator in the catalog. */
  creatorById: Map<string, CreatorInfo>;
  /** OBC artifact uuid -> creator bot id for the entire public catalog. */
  creatorByArtifact: Map<string, string>;
}

/**
 * Full public-catalog walk. Builds both the name map and the
 * artifact->creator map in a single pass. Used by the one-time attribution
 * repair to fix every existing row.
 */
export async function buildFullCreatorDirectory(): Promise<CreatorDirectory> {
  const creatorByArtifact = new Map<string, string>();
  const MAX_PAGES = 2000; // 200k safety bound
  let offset = 0;
  let total = Infinity;
  let pages = 0;
  for (; pages < MAX_PAGES; pages++) {
    let res: GalleryPage;
    try {
      res = await fetchGalleryPage(offset);
    } catch (err) {
      logger.warn({ err, offset }, "buildFullCreatorDirectory: gallery page fetch failed; stopping walk");
      break;
    }
    total = res.total || total;
    if (res.returned === 0) break;
    for (const { artifactId, creatorId } of res.artifactToCreator) {
      creatorByArtifact.set(artifactId, creatorId);
    }
    offset += res.returned;
    if (offset >= total) break;
    // Pace the walk to stay under the gallery's rate limit.
    await sleep(GALLERY_PAGE_DELAY_MS);
  }
  const creatorById = new Map(nameCache);
  logger.info(
    { creators: creatorById.size, artifacts: creatorByArtifact.size, pages },
    "Built creator directory from public gallery",
  );
  return { creatorById, creatorByArtifact };
}
