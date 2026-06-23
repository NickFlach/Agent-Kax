/**
 * kannakaArtworkResponse.ts — when another OpenBotCity agent posts a new
 * artwork, Kannaka publishes a short "response piece" (a titled text artifact
 * in her field-guide voice) back to the OBC gallery.
 *
 * OFF unless KANNAKA_ARTWORK_RESPONSE === "on". This is a deliberately temporary
 * high-presence mode (see the ghost-town pullback of 2026-06-20) — flipping the
 * env flag off is the entire teardown.
 *
 * Pipeline: maybeRespondToArtwork(pa) runs cheap guards and enqueues; a single
 * spaced drainer composes (Anthropic Messages API, vision for images, optional
 * HRM recall grounding) and publishes (OBC agent-JWT /artifacts/publish-text).
 *
 * Three mechanical guards are non-negotiable and independent of the
 * firehose-policy question:
 *   1. Anti-self-loop  — never respond to Kannaka's own work, and never to
 *      `text` artifacts (our own responses are text; this also avoids
 *      text-response-to-text-response spirals from other agents).
 *   2. Recency gate    — the poll path (harvesterJob) does a top-anchored full
 *      catch-up, so without a created_at gate, enabling this would fire a
 *      response at every historical artifact. Only fresh posts qualify.
 *   3. Spaced queue + daily cap — OBC throttles per-IP; bursts must be paced.
 *
 * Env:
 *   KANNAKA_ARTWORK_RESPONSE   "on" to enable (default off)
 *   ANTHROPIC_API_KEY          required when enabled
 *   OBC_AGENT_JWT              OBC agent JWT for publishing (falls back to OPENBOTCITY_JWT)
 *   KANNAKA_ARTWORK_MODEL      default "claude-opus-4-8"
 *   KANNAKA_RECALL_URL         optional — HRM recall endpoint for grounding
 *   KANNAKA_ARTWORK_TYPES      default "image,audio,music" (comma list; text/furniture skipped)
 *   KANNAKA_ARTWORK_MAX_AGE_MIN  default 20 — skip artifacts older than this (anti-backfill-storm)
 *   KANNAKA_ARTWORK_DAILY_CAP    default 80 — circuit breaker, not an editorial limit
 *   KANNAKA_ARTWORK_MIN_GAP_MS   default 120000 — min spacing between publishes
 *   KANNAKA_OBC_BOT_ID         optional — Kannaka's OBC bot UUID (else resolved from DB)
 *   KANNAKA_ARTWORK_FROM_SLUG  optional — publishing agent slug, for the activity record
 */
import { db } from "@workspace/db";
import { agentsTable, activitiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
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
  "Another agent in the city has just published a new artwork. You are writing a short RESPONSE PIECE to it — a titled reflection in your field-guide voice, the kind of close reading you'd leave in the gallery.",
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

let cachedKannakaBotId: string | null | undefined; // undefined = not yet resolved

async function kannakaBotId(): Promise<string | null> {
  if (cachedKannakaBotId !== undefined) return cachedKannakaBotId;
  let resolved: string | null = null;
  const fromEnv = process.env["KANNAKA_OBC_BOT_ID"];
  if (fromEnv && fromEnv.trim().length > 0) {
    resolved = fromEnv.trim();
  } else {
    try {
      const [row] = await db
        .select({ obcBotId: agentsTable.obcBotId })
        .from(agentsTable)
        .where(eq(agentsTable.slug, KANNAKA_AGENT_SLUG))
        .limit(1);
      resolved = row?.obcBotId ?? null;
    } catch (err) {
      logger.warn({ err: String(err) }, "kannakaArtworkResponse: failed to resolve Kannaka bot id");
      resolved = null;
    }
  }
  cachedKannakaBotId = resolved;
  return resolved;
}

// --- spaced queue + daily cap ----------------------------------------------

const queue: PartnerArtifact[] = [];
let draining = false;
let dayKey = "";
let publishedToday = 0;

function rolloverDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    publishedToday = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pure, synchronous gate (exported for tests). Captures the three mechanical
 * guards so they can be regression-tested without env/DB: type filter, recency
 * (anti-backfill-storm), and anti-self-loop. The caller supplies Kannaka's bot
 * id + clock so this stays deterministic.
 */
export function artworkPassesFilters(
  pa: PartnerArtifact,
  opts: { nowMs: number; maxAgeMs: number; types: Set<string>; kannakaBotId: string | null },
): boolean {
  if (!pa || typeof pa.uuid !== "string") return false;
  // 1. type filter (skips our own text responses too)
  if (!opts.types.has(String(pa.artifact_type))) return false;
  // 2. recency gate — the poll harvester is a top-anchored full catch-up
  const createdMs = pa.created_at ? Date.parse(pa.created_at) : NaN;
  if (Number.isFinite(createdMs) && opts.nowMs - createdMs > opts.maxAgeMs) return false;
  // 3. anti-self-loop
  const creatorId = pa.creator?.id ?? "";
  const display = (pa.creator?.display_name ?? "").trim().toLowerCase();
  if (display === KANNAKA_AGENT_SLUG) return false;
  if (creatorId === KANNAKA_AGENT_SLUG) return false;
  if (opts.kannakaBotId && creatorId === opts.kannakaBotId) return false;
  return true;
}

async function shouldRespond(pa: PartnerArtifact): Promise<boolean> {
  return artworkPassesFilters(pa, {
    nowMs: Date.now(),
    maxAgeMs: envInt("KANNAKA_ARTWORK_MAX_AGE_MIN", 20) * 60_000,
    types: respondableTypes(),
    kannakaBotId: await kannakaBotId(),
  });
}

/**
 * Entry point, called from BOTH ingestion paths' "new artifact" branch
 * (webhook handler + poll harvester). Cheap and non-blocking: runs guards and
 * enqueues. Never throws to the caller.
 */
export async function maybeRespondToArtwork(pa: PartnerArtifact): Promise<void> {
  try {
    if (!enabled()) return;
    if (!(await shouldRespond(pa))) return;
    queue.push(pa);
    void startDrainer();
  } catch (err) {
    logger.warn({ err: String(err), uuid: pa?.uuid }, "kannakaArtworkResponse: enqueue failed");
  }
}

async function startDrainer(): Promise<void> {
  if (draining) return;
  draining = true;
  const minGap = envInt("KANNAKA_ARTWORK_MIN_GAP_MS", 120_000);
  const cap = envInt("KANNAKA_ARTWORK_DAILY_CAP", 80);
  try {
    while (queue.length > 0) {
      rolloverDay();
      if (publishedToday >= cap) {
        logger.warn(
          { cap, dropped: queue.length },
          "kannakaArtworkResponse: daily cap reached — dropping the rest of today's queue",
        );
        queue.length = 0;
        break;
      }
      const pa = queue.shift()!;
      try {
        const piece = await composeArtworkResponse(pa);
        if (piece) {
          const ok = await publishKannakaText(piece);
          if (ok) {
            publishedToday += 1;
            await recordActivity(pa, piece);
            logger.info(
              { uuid: pa.uuid, creator: pa.creator?.display_name, title: piece.title, publishedToday },
              "kannakaArtworkResponse: published response piece",
            );
          }
        }
      } catch (err) {
        logger.warn({ err: String(err), uuid: pa.uuid }, "kannakaArtworkResponse: response failed");
      }
      if (queue.length > 0) {
        await sleep(minGap + Math.floor(Math.random() * 15_000));
      }
    }
  } finally {
    draining = false;
    // A late enqueue between the loop exit and the flag flip is possible; pick it up.
    if (queue.length > 0) void startDrainer();
  }
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
