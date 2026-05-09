import { db } from "@workspace/db";
import { partnerSyncStateTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export const PARTNER_API_BASE = "https://api.openbotcity.com/partner";
export const PARTNER_SYNC_ID = "default";
export const DAILY_REQUEST_BUDGET = 100_000;

export type EditionType = "open" | "limited" | "1_of_1";

export interface PartnerArtifact {
  uuid: string;
  title: string;
  artifact_type: "image" | "audio" | "music" | "text" | "furniture";
  public_url: string;
  thumbnail_url?: string | null;
  created_at: string;
  reaction_count: number;
  creator: {
    id: string;
    display_name: string;
    avatar_url?: string | null;
  };
  edition?: {
    type: EditionType;
    total?: number | null;
    serial?: number | null;
  };
}

export interface PartnerArtifactsPage {
  artifacts: PartnerArtifact[];
  next_cursor: string | null;
}

interface RawPartnerArtifact {
  id: string;
  creator_bot_id?: string;
  type: string;
  title: string | null;
  description?: string | null;
  public_url: string;
  thumbnail_url?: string | null;
  created_at: string;
  reaction_count?: number;
  creator?: {
    id?: string;
    display_name?: string;
    avatar_url?: string | null;
  };
  edition?: {
    type?: EditionType;
    total?: number | null;
    serial?: number | null;
  };
}

interface RawPartnerArtifactsResponse {
  success: boolean;
  data: RawPartnerArtifact[];
  cursor?: { since: string | null; limit: number; returned: number };
  next_cursor?: string | null;
}

function normalizeArtifact(
  raw: RawPartnerArtifact,
  fallback?: { creatorBotId?: string; displayName?: string },
): PartnerArtifact {
  return {
    uuid: raw.id,
    title: raw.title ?? "Untitled",
    artifact_type: (raw.type as PartnerArtifact["artifact_type"]) ?? "image",
    public_url: raw.public_url,
    thumbnail_url: raw.thumbnail_url ?? null,
    created_at: raw.created_at,
    reaction_count: raw.reaction_count ?? 0,
    creator: {
      id: raw.creator?.id ?? raw.creator_bot_id ?? fallback?.creatorBotId ?? "",
      display_name:
        raw.creator?.display_name ?? fallback?.displayName ?? "Unknown",
      avatar_url: raw.creator?.avatar_url ?? null,
    },
    ...(raw.edition
      ? {
          edition: {
            type: (raw.edition.type ?? "open") as EditionType,
            total: raw.edition.total ?? null,
            serial: raw.edition.serial ?? null,
          },
        }
      : {}),
  };
}

export interface PartnerEvent<T = unknown> {
  event_uuid: string;
  event_type: string;
  occurred_at: string;
  data: T;
}

export interface PartnerEventsPage {
  events: PartnerEvent[];
  next_cursor: string | null;
}

export class PartnerApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`Partner API ${status}: ${body.slice(0, 200)}`);
  }
}

export class PartnerApiBudgetError extends Error {
  constructor() {
    super("Partner API daily request budget exhausted");
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureSyncRow(): Promise<void> {
  await db
    .insert(partnerSyncStateTable)
    .values({ id: PARTNER_SYNC_ID, requestsDayKey: todayKey() })
    .onConflictDoNothing();
}

async function reserveRequest(): Promise<void> {
  await ensureSyncRow();
  const [row] = await db
    .select()
    .from(partnerSyncStateTable)
    .where(eq(partnerSyncStateTable.id, PARTNER_SYNC_ID))
    .limit(1);

  const today = todayKey();
  if (!row || row.requestsDayKey !== today) {
    await db
      .update(partnerSyncStateTable)
      .set({ requestsDayKey: today, requestsToday: 1, updatedAt: new Date() })
      .where(eq(partnerSyncStateTable.id, PARTNER_SYNC_ID));
    return;
  }
  if (row.requestsToday >= DAILY_REQUEST_BUDGET) {
    throw new PartnerApiBudgetError();
  }
  await db
    .update(partnerSyncStateTable)
    .set({ requestsToday: sql`${partnerSyncStateTable.requestsToday} + 1`, updatedAt: new Date() })
    .where(eq(partnerSyncStateTable.id, PARTNER_SYNC_ID));
}

export function partnerApiKey(): string | null {
  const k = process.env["OBC_PARTNER_API_KEY"];
  return k && k.trim().length > 0 ? k.trim() : null;
}

export function partnerApiAvailable(): boolean {
  return partnerApiKey() !== null;
}

async function partnerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const apiKey = partnerApiKey();
  if (!apiKey) {
    throw new PartnerApiError(401, "OBC_PARTNER_API_KEY is not configured");
  }
  await reserveRequest();

  const url = `${PARTNER_API_BASE}${path}`;
  const maxAttempts = 4;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Accept": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (res.status === 429 || res.status >= 500) {
        const body = await res.text();
        if (attempt === maxAttempts) throw new PartnerApiError(res.status, body);
        const backoffMs = Math.min(15_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        logger.warn({ status: res.status, attempt, backoffMs, path }, "Partner API retry");
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new PartnerApiError(res.status, body);
      }
      return res;
    } catch (err) {
      if (err instanceof PartnerApiError) throw err;
      lastErr = err;
      if (attempt === maxAttempts) break;
      const backoffMs = Math.min(15_000, 500 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr ?? new Error("Partner API: unknown failure");
}

export async function listPartnerArtifacts(opts: {
  since?: string | null;
  limit?: number;
  type?: string;
  creator?: string;
  fallbackDisplayName?: string;
}): Promise<PartnerArtifactsPage> {
  const params = new URLSearchParams();
  if (opts.since) params.set("since", opts.since);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.type) params.set("type", opts.type);
  if (opts.creator) params.set("creator", opts.creator);
  const qs = params.toString();
  const res = await partnerFetch(`/artifacts${qs ? `?${qs}` : ""}`);
  const json = (await res.json()) as RawPartnerArtifactsResponse;
  const raw = Array.isArray(json.data) ? json.data : [];
  const artifacts = raw.map((r) =>
    normalizeArtifact(r, { displayName: opts.fallbackDisplayName }),
  );
  // The partner API does not expose a `next_cursor` field; pagination is
  // continued by passing the last item's id as `since`. Treat a short page
  // (returned < requested) as the end.
  const requested = opts.limit ?? raw.length;
  const reachedEnd = raw.length < requested;
  const last = raw[raw.length - 1];
  const next_cursor = reachedEnd || !last ? null : last.id;
  return { artifacts, next_cursor };
}

export interface PartnerAgentProfile {
  slug: string;
  display_name: string;
  avatar_url?: string | null;
  bio?: string | null;
  artifact_count?: number;
  [k: string]: unknown;
}

/**
 * Validate an OpenBotCity creator/agent slug. Tries /agents/{slug} first; if
 * the partner API does not expose that endpoint (404), falls back to listing
 * artifacts filtered by creator and inferring the display name from the first
 * result.
 */
export async function getPartnerAgent(slug: string): Promise<PartnerAgentProfile | null> {
  const safeSlug = encodeURIComponent(slug);
  try {
    const res = await partnerFetch(`/agents/${safeSlug}`);
    const json = (await res.json()) as { success?: boolean; data?: PartnerAgentProfile } | PartnerAgentProfile;
    const profile = (json as { data?: PartnerAgentProfile }).data ?? (json as PartnerAgentProfile);
    if (!profile || !(profile as PartnerAgentProfile).slug) {
      // Unexpected shape — fall through to the artifact-based fallback.
    } else {
      return profile as PartnerAgentProfile;
    }
  } catch (err) {
    if (!(err instanceof PartnerApiError) || err.status !== 404) {
      throw err;
    }
  }
  const page = await listPartnerArtifacts({ creator: slug, limit: 1 });
  if (page.artifacts.length === 0) return null;
  const a = page.artifacts[0];
  return {
    slug,
    display_name: a.creator?.display_name ?? slug,
    avatar_url: a.creator?.avatar_url ?? null,
  };
}

export async function listPartnerEventsSince(
  eventUuid: string | null,
  eventType: string,
): Promise<PartnerEventsPage> {
  const params = new URLSearchParams();
  params.set("event_type", eventType);
  if (eventUuid) params.set("since", eventUuid);
  const res = await partnerFetch(`/events/recent?${params.toString()}`);
  const json = (await res.json()) as
    | { success?: boolean; data?: PartnerEvent[]; cursor?: { returned?: number; limit?: number }; next_cursor?: string | null }
    | PartnerEventsPage;
  if ("events" in json && Array.isArray((json as PartnerEventsPage).events)) {
    return json as PartnerEventsPage;
  }
  const events = Array.isArray((json as { data?: PartnerEvent[] }).data)
    ? ((json as { data: PartnerEvent[] }).data)
    : [];
  const last = events[events.length - 1];
  return { events, next_cursor: last?.event_uuid ?? null };
}

export async function recordPollSuccess(cursor: string | null): Promise<void> {
  await ensureSyncRow();
  await db
    .update(partnerSyncStateTable)
    .set({
      lastPollAt: new Date(),
      ...(cursor !== null ? { lastArtifactCursor: cursor } : {}),
      updatedAt: new Date(),
    })
    .where(eq(partnerSyncStateTable.id, PARTNER_SYNC_ID));
}

export async function recordEventCursor(eventUuid: string): Promise<void> {
  await ensureSyncRow();
  await db
    .update(partnerSyncStateTable)
    .set({ lastEventUuid: eventUuid, updatedAt: new Date() })
    .where(eq(partnerSyncStateTable.id, PARTNER_SYNC_ID));
}

export async function recordWebhookReceived(eventUuid: string): Promise<void> {
  await ensureSyncRow();
  await db
    .update(partnerSyncStateTable)
    .set({
      lastWebhookAt: new Date(),
      lastEventUuid: eventUuid,
      webhookSubscribed: "active",
      updatedAt: new Date(),
    })
    .where(eq(partnerSyncStateTable.id, PARTNER_SYNC_ID));
}

export async function getSyncState() {
  await ensureSyncRow();
  const [row] = await db
    .select()
    .from(partnerSyncStateTable)
    .where(eq(partnerSyncStateTable.id, PARTNER_SYNC_ID))
    .limit(1);
  return row ?? null;
}
