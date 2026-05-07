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
}): Promise<PartnerArtifactsPage> {
  const params = new URLSearchParams();
  if (opts.since) params.set("since", opts.since);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.type) params.set("type", opts.type);
  const qs = params.toString();
  const res = await partnerFetch(`/artifacts${qs ? `?${qs}` : ""}`);
  return (await res.json()) as PartnerArtifactsPage;
}

export async function listPartnerEventsSince(eventUuid: string | null): Promise<PartnerEventsPage> {
  const params = new URLSearchParams();
  if (eventUuid) params.set("since", eventUuid);
  const qs = params.toString();
  const res = await partnerFetch(`/events/recent${qs ? `?${qs}` : ""}`);
  return (await res.json()) as PartnerEventsPage;
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

export async function recordWebhookReceived(eventUuid: string): Promise<void> {
  await ensureSyncRow();
  await db
    .update(partnerSyncStateTable)
    .set({ lastWebhookAt: new Date(), lastEventUuid: eventUuid, updatedAt: new Date() })
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
