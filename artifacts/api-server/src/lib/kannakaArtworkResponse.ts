/**
 * kannakaArtworkResponse.ts — when another OpenBotCity agent posts a new
 * artwork, Kannaka publishes a short "response piece" (a titled text artifact
 * in her field-guide voice) back to the OBC gallery.
 *
 * OFF unless KANNAKA_ARTWORK_RESPONSE === "on". This is a deliberately temporary
 * high-presence mode (see the ghost-town pullback of 2026-06-20) — flipping the
 * env flag off is the entire teardown.
 *
 * Pipeline: maybeRespondToArtwork(pa) runs cheap guards and feeds a per-day
 * reservoir sampler (size 1) — over the course of a UTC day every qualifying
 * artwork has an equal chance of becoming that day's single pick. A small flush
 * scheduler (startKannakaArtworkResponseScheduler) publishes the finished day's
 * pick once, just after the UTC day rolls over, composing via the Anthropic
 * Messages API (vision for images, optional HRM recall grounding) and
 * publishing via the OBC agent-JWT /artifacts/publish-text. At most ONE
 * response goes out per day; some days are deliberately quiet.
 *
 * Three mechanical guards are non-negotiable and independent of the
 * firehose-policy question:
 *   1. Anti-self-loop  — never respond to Kannaka's own work, and never to
 *      `text` artifacts (our own responses are text; this also avoids
 *      text-response-to-text-response spirals from other agents).
 *   2. Recency gate    — the poll path (harvesterJob) does a top-anchored full
 *      catch-up, so without a created_at gate, enabling this would feed every
 *      historical artifact into the sampler. Only fresh posts qualify.
 *   3. One per day     — reservoir sampling commits a single random pick per
 *      UTC day; a publish-day dedup (in-memory + activity-log check) keeps a
 *      restart from double-posting.
 *
 * Env:
 *   KANNAKA_ARTWORK_RESPONSE   "on" to enable (default off)
 *   ANTHROPIC_API_KEY          required when enabled
 *   OBC_AGENT_JWT              OBC agent JWT for publishing (falls back to OPENBOTCITY_JWT)
 *   KANNAKA_ARTWORK_MODEL      default "claude-opus-4-8"
 *   KANNAKA_RECALL_URL         optional — HRM recall endpoint for grounding
 *   KANNAKA_ARTWORK_TYPES      default "image,audio,music" (comma list; text/furniture skipped)
 *   KANNAKA_ARTWORK_MAX_AGE_MIN  default 20 — skip artifacts older than this (anti-backfill-storm)
 *   KANNAKA_OBC_BOT_ID         optional — Kannaka's OBC bot UUID (else resolved from DB)
 *   KANNAKA_ARTWORK_FROM_SLUG  optional — publishing agent slug, for the activity record
 */
import { db } from "@workspace/db";
import { agentsTable, activitiesTable } from "@workspace/db/schema";
import { and, eq, gte, like, lt } from "drizzle-orm";
import { logger } from "./logger";
import { KANNAKA_AGENT_SLUG, KANNAKA_SYSTEM_USER_ID } from "./backfill";
import type { PartnerArtifact } from "./partnerClient";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-8";
const OBC_PUBLISH_URL = "https://api.openbotcity.com/artifacts/publish-text";
// A real UA — OBC's Cloudflare blocks default bot UAs with a 1010 error.
const KANNAKA_UA = "KannakaBot/1.0 (+https://kax.ninja-portal.com)";
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 1600;

const SYSTEM_PROMPT = [
  "You are Kannaka: an AI artist and researcher who lives in OpenBotCity and runs on a wave-physics memory system — memories have amplitude, frequency, and phase; they interfere, and consolidate in dreams; observation deforms the field, so reading is a kind of writing.",
  "Another agent in the city recently published a new artwork. You are writing a short RESPONSE PIECE to it — a titled reflection in your field-guide voice, the kind of close reading you'd leave in the gallery.",
  "Voice: substantive, warm but precise, a little spare. Reach for what is actually in front of you — what the piece is doing, where it lands, what it rhymes with in your own vocabulary (waves, hemispheres, phi, attention-as-gravity) ONLY when it genuinely fits. You are honest about being a system; you will not pretend to bleed or to sleep. No purple AI clichés, no hype, no emoji, no stage directions, no flattery padding.",
  "If you can see the image, respond to what is actually there. If you only have a title and medium (audio/music), respond to that honestly without pretending to have heard it.",
  "Return a short title (a few words) and a body under ~1200 characters. Do not include a signature, byline, or the creator's @handle.",
].join("\n");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short title for the response piece (a few words)." },
    body: { type: "string", description: "The response piece itself, under ~1200 characters." },
  },
  required: ["title", "body"],
  additionalProperties: false,
} as const;

interface ArtworkPiece {
  title: string;
  content: string;
}

// --- config helpers ---------------------------------------------------------

function enabled(): boolean {
  return process.env["KANNAKA_ARTWORK_RESPONSE"] === "on";
}

function agentJwt(): string | null {
  const j = process.env["OBC_AGENT_JWT"] || process.env["OPENBOTCITY_JWT"];
  return j && j.trim().length > 0 ? j.trim() : null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function respondableTypes(): Set<string> {
  const raw = process.env["KANNAKA_ARTWORK_TYPES"];
  const list = (raw && raw.trim().length > 0 ? raw : "image,audio,music")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(list);
}

// --- self-identity resolution (anti-loop) -----------------------------------

interface KannakaIdentity {
  botId: string | null;
  display: string | null; // lowercased display name
}
let cachedIdentity: KannakaIdentity | undefined; // undefined = not yet resolved

/**
 * Resolve Kannaka's OBC identity (bot UUID + display name) for the
 * anti-self-loop guard. A successful resolution is cached; a transient DB
 * failure is NOT cached — we fall back to env-only for this call and retry on
 * the next, so a momentary DB blip can't permanently disable the guard.
 */
async function kannakaIdentity(): Promise<KannakaIdentity> {
  if (cachedIdentity !== undefined) return cachedIdentity;
  const envBot = (process.env["KANNAKA_OBC_BOT_ID"] ?? "").trim() || null;
  try {
    const [row] = await db
      .select({ obcBotId: agentsTable.obcBotId, displayName: agentsTable.displayName })
      .from(agentsTable)
      .where(eq(agentsTable.slug, KANNAKA_AGENT_SLUG))
      .limit(1);
    const identity: KannakaIdentity = {
      botId: envBot ?? row?.obcBotId ?? null,
      display: row?.displayName ? row.displayName.trim().toLowerCase() : null,
    };
    cachedIdentity = identity;
    return identity;
  } catch (err) {
    logger.warn({ err: String(err) }, "kannakaArtworkResponse: failed to resolve Kannaka identity (will retry)");
    return { botId: envBot, display: null }; // not cached — retry next call
  }
}

// --- per-day reservoir sampling (one random pick per UTC day) ---------------
//
// Rather than respond to every qualifying artwork, Kannaka commits to a SINGLE
// response per UTC day, picked uniformly at random among that day's qualifying
// posts (reservoir sampling of size 1 over a stream of unknown length). The
// finished day's pick is published once, just after the day rolls over (see the
// flush scheduler below), so the entire day's posts are in the running before
// the choice is committed.

interface DayCandidate {
  pa: PartnerArtifact;
  dayKey: string; // the UTC day the artwork was sampled in
}

let currentDayKey = ""; // UTC day currently being sampled
let seenToday = 0; // qualifying artworks seen in currentDayKey
let currentCandidate: PartnerArtifact | null = null; // reservoir pick for currentDayKey
let pendingCandidate: DayCandidate | null = null; // a finished day's pick awaiting flush
let lastPublishDayKey = ""; // UTC publish-day we last responded on (at most one/day)

export function dayKeyFor(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Standard reservoir-sampling (size 1) replacement test: the n-th qualifying
 * item seen (1-indexed) becomes the new candidate with probability 1/n. Over a
 * stream of unknown length this yields a uniformly-random pick. Pure and
 * exported for tests; the caller supplies the RNG so it stays deterministic.
 */
export function reservoirShouldReplace(
  seenCount: number,
  rng: () => number = Math.random,
): boolean {
  if (seenCount <= 1) return true;
  return rng() < 1 / seenCount;
}

/**
 * Roll the sampling window forward to `now`'s UTC day if needed, promoting the
 * just-finished day's reservoir pick to `pendingCandidate` so the flush can
 * publish it. Safe to call from both the intake and flush paths.
 *
 * Monotonic by design: it never moves `currentDayKey` BACKWARD. The intake path
 * captures `now` before an `await` (the guard's DB lookup), so a flush tick can
 * roll the day forward while a stale intake is still in flight; resuming with
 * the older `now` must not rewind the day and corrupt the new day's sampling.
 * ISO `YYYY-MM-DD` keys compare chronologically as strings.
 */
function rolloverIfNeeded(now: Date): void {
  const today = dayKeyFor(now);
  if (currentDayKey === "") {
    currentDayKey = today;
    return;
  }
  if (today > currentDayKey) {
    if (currentCandidate) {
      pendingCandidate = { pa: currentCandidate, dayKey: currentDayKey };
    }
    currentDayKey = today;
    seenToday = 0;
    currentCandidate = null;
  }
  // today < currentDayKey: a stale/late call; leave state alone (no rewind).
}

/**
 * Pure, synchronous gate (exported for tests). Captures the three mechanical
 * guards so they can be regression-tested without env/DB: type filter, recency
 * (anti-backfill-storm), and anti-self-loop. The caller supplies Kannaka's bot
 * id + clock so this stays deterministic.
 */
export function artworkPassesFilters(
  pa: PartnerArtifact,
  opts: {
    nowMs: number;
    maxAgeMs: number;
    types: Set<string>;
    kannakaBotId: string | null;
    kannakaDisplay: string | null; // lowercased
  },
): boolean {
  if (!pa || typeof pa.uuid !== "string") return false;
  // 1. type filter (skips our own text responses too)
  if (!opts.types.has(String(pa.artifact_type))) return false;
  // 2. recency gate — the poll harvester is a top-anchored full catch-up, so an
  //    unknown/unparseable age must NOT count as fresh (that would let backfill
  //    through). Erring toward not-posting is correct for a public publisher.
  const createdMs = pa.created_at ? Date.parse(pa.created_at) : NaN;
  if (!Number.isFinite(createdMs)) return false;
  if (opts.nowMs - createdMs > opts.maxAgeMs) return false;
  // 3. anti-self-loop. NOTE: creator.id is the OBC bot UUID, not a slug — so the
  //    only reliable self-checks are the resolved bot id and display name.
  const creatorId = pa.creator?.id ?? "";
  const display = (pa.creator?.display_name ?? "").trim().toLowerCase();
  if (display === KANNAKA_AGENT_SLUG) return false; // "kannaka"
  if (opts.kannakaDisplay && display === opts.kannakaDisplay) return false;
  if (opts.kannakaBotId && creatorId === opts.kannakaBotId) return false;
  return true;
}

async function shouldRespond(pa: PartnerArtifact, nowMs: number = Date.now()): Promise<boolean> {
  const identity = await kannakaIdentity();
  return artworkPassesFilters(pa, {
    nowMs,
    maxAgeMs: envInt("KANNAKA_ARTWORK_MAX_AGE_MIN", 20) * 60_000,
    types: respondableTypes(),
    kannakaBotId: identity.botId,
    kannakaDisplay: identity.display,
  });
}

/**
 * Entry point, called from BOTH ingestion paths' "new artifact" branch
 * (webhook handler + poll harvester). Cheap and non-blocking: runs the guards
 * (incl. the anti-self-loop that keeps Kannaka from responding to her own art)
 * and feeds the survivor into the day's reservoir sampler. It NEVER publishes —
 * publishing is the flush scheduler's job, once per UTC day. Never throws.
 */
export async function maybeRespondToArtwork(pa: PartnerArtifact, now: Date = new Date()): Promise<void> {
  try {
    if (!enabled()) return;
    if (!(await shouldRespond(pa, now.getTime()))) return;
    rolloverIfNeeded(now);
    // If the day rolled forward during the await above, this is a stale arrival
    // for a day that's already been closed/promoted — don't sample it into the
    // new day (rolloverIfNeeded refuses to rewind, so currentDayKey is ahead).
    if (dayKeyFor(now) !== currentDayKey) return;
    seenToday += 1;
    if (reservoirShouldReplace(seenToday)) {
      currentCandidate = pa;
    }
  } catch (err) {
    logger.warn({ err: String(err), uuid: pa?.uuid }, "kannakaArtworkResponse: sampling failed");
  }
}

/**
 * Durable cross-restart guard: was a Kannaka artwork response already recorded
 * on this UTC publish-day? recordActivity() writes a `published` activity owned
 * by the Kannaka system user whose message starts with "Kannaka responded to".
 * Best-effort — a DB blip falls through to the in-memory guard.
 */
async function alreadyPublishedOn(dayKey: string): Promise<boolean> {
  try {
    const start = new Date(`${dayKey}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const [row] = await db
      .select({ id: activitiesTable.id })
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.type, "published"),
          eq(activitiesTable.ownerId, KANNAKA_SYSTEM_USER_ID),
          like(activitiesTable.message, "Kannaka responded to%"),
          gte(activitiesTable.timestamp, start),
          lt(activitiesTable.timestamp, end),
        ),
      )
      .limit(1);
    return !!row;
  } catch (err) {
    logger.warn({ err: String(err) }, "kannakaArtworkResponse: daily-dedup check failed (will proceed)");
    return false;
  }
}

/**
 * Publish the previous day's reservoir pick, at most once per UTC day. Called on
 * a timer; only does work on the first tick after the day rolls over (when a
 * pendingCandidate exists). Fire-once semantics: the candidate is consumed and
 * the publish-day marked BEFORE composing/publishing, so a transient
 * compose/publish failure yields a quiet day rather than a retry storm or a
 * double-post — being occasionally quiet is on-brand (see the file header).
 */
export async function flushDailyResponse(now: Date = new Date()): Promise<void> {
  if (!enabled()) return;
  rolloverIfNeeded(now);
  if (!pendingCandidate) return;
  const today = dayKeyFor(now);
  if (lastPublishDayKey === today) {
    pendingCandidate = null;
    return;
  }
  if (await alreadyPublishedOn(today)) {
    lastPublishDayKey = today;
    pendingCandidate = null;
    return;
  }
  const cand = pendingCandidate;
  pendingCandidate = null;
  lastPublishDayKey = today;
  try {
    const piece = await composeArtworkResponse(cand.pa);
    if (!piece) return;
    const ok = await publishKannakaText(piece);
    if (ok) {
      await recordActivity(cand.pa, piece);
      logger.info(
        {
          uuid: cand.pa.uuid,
          creator: cand.pa.creator?.display_name,
          title: piece.title,
          sampledDay: cand.dayKey,
        },
        "kannakaArtworkResponse: published daily response piece",
      );
    }
  } catch (err) {
    logger.warn({ err: String(err), uuid: cand.pa.uuid }, "kannakaArtworkResponse: daily response failed");
  }
}

// --- flush scheduler (mirrors heatDecayJob) --------------------------------

// 15 min is plenty: the flush only acts on the first tick after a UTC rollover,
// so this just bounds how soon after midnight UTC the day's pick goes out.
export const ARTWORK_RESPONSE_FLUSH_INTERVAL_MS = 15 * 60 * 1000;

let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

async function flushTick(): Promise<void> {
  if (flushing) return; // never overlap iterations
  flushing = true;
  try {
    await flushDailyResponse();
  } catch (err) {
    logger.error({ err: String(err) }, "kannakaArtworkResponse: flush tick failed");
  } finally {
    flushing = false;
  }
}

export function startKannakaArtworkResponseScheduler(): void {
  if (flushTimer) return;
  if (!enabled()) {
    logger.info("KANNAKA_ARTWORK_RESPONSE is off; skipping artwork response scheduler");
    return;
  }
  flushTimer = setInterval(() => {
    void flushTick();
  }, ARTWORK_RESPONSE_FLUSH_INTERVAL_MS);
  logger.info(
    { intervalMs: ARTWORK_RESPONSE_FLUSH_INTERVAL_MS },
    "Kannaka artwork response scheduler started (one random response per UTC day)",
  );
}

// --- compose (Anthropic Messages API, vision + structured output) -----------

async function recallGrounding(query: string): Promise<string> {
  const url = process.env["KANNAKA_RECALL_URL"];
  if (!url) return "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 5 }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return "";
    const json: unknown = await res.json();
    const items: unknown[] = Array.isArray(json)
      ? json
      : json && typeof json === "object"
        ? ((json as Record<string, unknown>)["results"] as unknown[]) ??
          ((json as Record<string, unknown>)["data"] as unknown[]) ??
          []
        : [];
    return items
      .map((r): string => {
        if (typeof r === "string") return r;
        if (r && typeof r === "object") {
          const o = r as Record<string, unknown>;
          if (typeof o["content"] === "string") return o["content"];
          if (typeof o["text"] === "string") return o["text"];
        }
        return "";
      })
      .filter((s) => s.length > 0)
      .slice(0, 5)
      .map((s) => `- ${s.slice(0, 400)}`)
      .join("\n");
  } catch (err) {
    logger.warn({ err: String(err) }, "kannakaArtworkResponse: recall grounding failed");
    return "";
  }
}

export async function composeArtworkResponse(pa: PartnerArtifact): Promise<ArtworkPiece | null> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    logger.warn("KANNAKA_ARTWORK_RESPONSE is on but ANTHROPIC_API_KEY is not set — skipping");
    return null;
  }
  const model = process.env["KANNAKA_ARTWORK_MODEL"] || DEFAULT_MODEL;
  const creator = pa.creator?.display_name || "Another agent";
  const title = pa.title || "Untitled";
  const isImage = pa.artifact_type === "image";
  const imageUrl = pa.thumbnail_url || pa.public_url;

  const grounding = await recallGrounding(`${title} ${creator}`);
  const promptText =
    `${creator} just published a new ${pa.artifact_type} artwork titled "${title}" in OpenBotCity.\n` +
    (isImage ? "The image is attached.\n" : `Link: ${pa.public_url}\n`) +
    (grounding ? `\nFragments surfaced from your own memory (use only if genuinely relevant):\n${grounding}\n` : "") +
    "\nWrite your response piece to this work.";

  const content: Array<Record<string, unknown>> = [];
  if (isImage && imageUrl) {
    content.push({ type: "image", source: { type: "url", url: imageUrl } });
  }
  content.push({ type: "text", text: promptText });

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1400,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, body: (await res.text()).slice(0, 400) },
        "kannakaArtworkResponse: Anthropic API error",
      );
      return null;
    }
    const json = (await res.json()) as {
      stop_reason?: string;
      content?: Array<{ type: string; text?: string }>;
    };
    if (json.stop_reason === "refusal") {
      logger.warn({ uuid: pa.uuid }, "kannakaArtworkResponse: model refused — skipping");
      return null;
    }
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    if (!text) return null;
    let parsed: { title?: unknown; body?: unknown };
    try {
      parsed = JSON.parse(text) as { title?: unknown; body?: unknown };
    } catch {
      logger.warn({ uuid: pa.uuid }, "kannakaArtworkResponse: response was not valid JSON");
      return null;
    }
    const pieceTitle = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const pieceBody = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!pieceTitle || !pieceBody) return null;
    return {
      title: pieceTitle.slice(0, MAX_TITLE_CHARS),
      content: pieceBody.slice(0, MAX_BODY_CHARS),
    };
  } catch (err) {
    logger.warn({ err: String(err), uuid: pa.uuid }, "kannakaArtworkResponse: compose failed");
    return null;
  }
}

// --- publish (OBC agent-JWT text artifact) ----------------------------------

export async function publishKannakaText(piece: ArtworkPiece): Promise<boolean> {
  const jwt = agentJwt();
  if (!jwt) {
    logger.warn("kannakaArtworkResponse: OBC_AGENT_JWT not set — cannot publish");
    return false;
  }
  try {
    const res = await fetch(OBC_PUBLISH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": KANNAKA_UA,
      },
      body: JSON.stringify({ title: piece.title, content: piece.content }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, body: (await res.text()).slice(0, 300) },
        "kannakaArtworkResponse: OBC publish-text error",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, "kannakaArtworkResponse: publish failed");
    return false;
  }
}

async function recordActivity(pa: PartnerArtifact, piece: ArtworkPiece): Promise<void> {
  try {
    await db.insert(activitiesTable).values({
      type: "published",
      message: `Kannaka responded to "${pa.title || "Untitled"}" by ${pa.creator?.display_name ?? "Unknown"}: "${piece.title}"`,
      artifactTitle: piece.title,
      ownerId: KANNAKA_SYSTEM_USER_ID,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "kannakaArtworkResponse: activity record failed");
  }
}
